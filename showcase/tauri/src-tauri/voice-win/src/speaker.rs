// Spoken replies on a speaker the user picked (Windows and Linux): the twin of SpeakerOutput in voice/main.swift.
// The app sends each reply as chunks of mono 16-bit audio ({"cmd":"speak_pcm","id","pcm" (base64),"rate"}); this plays
// them on the chosen output device, whatever the system default is, and {"cmd":"speak_stop"} cuts them off.
//
// The pieces that need no sound card (decoding, resampling) are plain functions with tests that run anywhere.
// The player itself lives on the main thread only (a cpal stream can't move between threads), so it is a
// thread-local, driven by the helper's command loop.

/// Decodes standard base64 (padding and line breaks allowed). None if anything else is in it.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Little-endian 16-bit samples to -1..1 floats (a trailing odd byte is dropped).
pub fn pcm16_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect()
}

/// Linear resampling that carries its position from one chunk to the next, so chunk edges don't click.
pub struct Resampler {
    step: f64,
    frac: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: f64, to: f64) -> Resampler {
        Resampler { step: from / to, frac: 0.0, prev: 0.0 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &cur in input {
            while self.frac < 1.0 {
                out.push(self.prev + (cur - self.prev) * self.frac as f32);
                self.frac += self.step;
            }
            self.frac -= 1.0;
            self.prev = cur;
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
mod player {
    use super::{b64_decode, pcm16_to_f32, Resampler};
    use crate::log;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SizedSample};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    struct Out {
        _stream: cpal::Stream,
        rate: u32,
        in_rate: f64,
        resampler: Resampler,
    }

    #[derive(Default)]
    struct Speaker {
        device: String,
        active: Option<String>,
        queue: Arc<Mutex<VecDeque<f32>>>,
        out: Option<Out>,
    }

    thread_local! { static SPEAKER: RefCell<Speaker> = RefCell::new(Speaker::default()); }

    fn open<T: SizedSample + FromSample<f32> + Send + 'static>(dev: &cpal::Device, cfg: cpal::StreamConfig, q: Arc<Mutex<VecDeque<f32>>>) -> Result<cpal::Stream, cpal::Error> {
        let ch = cfg.channels as usize;
        dev.build_output_stream::<T, _, _>(
            cfg,
            move |data: &mut [T], _| {
                let mut q = q.lock().unwrap();
                for frame in data.chunks_mut(ch) {
                    let v = T::from_sample(q.pop_front().unwrap_or(0.0));
                    for s in frame.iter_mut() {
                        *s = v;
                    }
                }
            },
            |e| log(&format!("speaker stream: {e}")),
            None,
        )
    }

    /// The output device with this id (see audio::device_lists), or the system default when it's gone.
    fn find(id: &str) -> Option<cpal::Device> {
        let host = cpal::default_host();
        if let Ok(list) = host.output_devices() {
            for d in list {
                if d.id().ok().map(|i| i.to_string()).as_deref() == Some(id) {
                    return Some(d);
                }
            }
        }
        log(&format!("speaker {id} isn't there: using the system default"));
        host.default_output_device()
    }

    fn start(sp: &mut Speaker, in_rate: f64) -> bool {
        if let Some(o) = &mut sp.out {
            if o.in_rate != in_rate {
                o.in_rate = in_rate;
                o.resampler = Resampler::new(in_rate, o.rate as f64);
            }
            return true;
        }
        let Some(dev) = find(&sp.device) else { return false };
        let supported = match dev.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                log(&format!("speaker: can't open ({e})"));
                return false;
            }
        };
        let (rate, fmt) = (supported.sample_rate(), supported.sample_format());
        let cfg: cpal::StreamConfig = supported.into();
        let q = sp.queue.clone();
        use cpal::SampleFormat as F;
        let stream = match fmt {
            F::F32 => open::<f32>(&dev, cfg, q),
            F::I16 => open::<i16>(&dev, cfg, q),
            F::I32 => open::<i32>(&dev, cfg, q),
            F::U16 => open::<u16>(&dev, cfg, q),
            F::F64 => open::<f64>(&dev, cfg, q),
            other => {
                log(&format!("speaker: unsupported format {other:?}"));
                return false;
            }
        };
        match stream.and_then(|s| s.play().map(|_| s)) {
            Ok(s) => {
                log(&format!("speaker on ({rate} Hz)"));
                sp.out = Some(Out { _stream: s, rate, in_rate, resampler: Resampler::new(in_rate, rate as f64) });
                true
            }
            Err(e) => {
                log(&format!("speaker: can't start ({e})"));
                false
            }
        }
    }

    /// The speaker to use ("" = none chosen: the page plays the sound itself).
    pub fn set_device(id: &str) {
        SPEAKER.with(|s| {
            let mut s = s.borrow_mut();
            if s.device == id {
                return;
            }
            s.device = id.to_owned();
            s.active = None;
            s.queue.lock().unwrap().clear();
            s.out = None;
        });
    }

    pub fn play(id: &str, b64: &str, rate: f64) {
        SPEAKER.with(|s| {
            let mut s = s.borrow_mut();
            if s.device.is_empty() {
                return;
            }
            if s.active.as_deref() != Some(id) {
                s.queue.lock().unwrap().clear(); // a new reply cuts off the last one
                s.active = Some(id.to_owned());
            }
            let Some(bytes) = b64_decode(b64) else { return };
            if bytes.len() < 2 {
                return;
            }
            if !start(&mut s, if rate > 0.0 { rate } else { 44100.0 }) {
                return;
            }
            let mut out = Vec::new();
            s.out.as_mut().unwrap().resampler.process(&pcm16_to_f32(&bytes), &mut out);
            s.queue.lock().unwrap().extend(out);
        });
    }

    pub fn stop() {
        SPEAKER.with(|s| {
            let mut s = s.borrow_mut();
            s.active = None;
            s.queue.lock().unwrap().clear();
        });
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod player {
    pub fn set_device(_id: &str) {}
    pub fn play(_id: &str, _b64: &str, _rate: f64) {}
    pub fn stop() {}
}

pub use player::{play, set_device, stop};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes_with_and_without_padding() {
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("aGVsbG8").unwrap(), b"hello");
        assert_eq!(b64_decode("aGk=\n").unwrap(), b"hi");
        assert_eq!(b64_decode("").unwrap(), b"");
        assert!(b64_decode("a*b").is_none(), "not base64");
        assert_eq!(b64_decode("+/8=").unwrap(), [0xfb, 0xff]);
    }

    #[test]
    fn pcm16_is_little_endian_and_scaled() {
        let f = pcm16_to_f32(&[0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff]);
        assert_eq!(f, vec![0.0, 0.5, -1.0], "an odd trailing byte is dropped");
    }

    #[test]
    fn same_rate_keeps_every_sample_one_step_late() {
        let mut r = Resampler::new(48000.0, 48000.0);
        let mut out = Vec::new();
        r.process(&[0.25, 0.5, 0.75], &mut out);
        assert_eq!(out, vec![0.0, 0.25, 0.5]);
    }

    #[test]
    fn upsampling_doubles_and_chunk_edges_are_seamless() {
        let whole: Vec<f32> = (0..40).map(|i| (i as f32 * 0.3).sin()).collect();
        let mut a = Resampler::new(24000.0, 48000.0);
        let mut one = Vec::new();
        a.process(&whole, &mut one);
        assert_eq!(one.len(), 80);
        let mut b = Resampler::new(24000.0, 48000.0);
        let mut two = Vec::new();
        b.process(&whole[..13], &mut two);
        b.process(&whole[13..], &mut two);
        assert_eq!(one, two, "splitting the audio into chunks changes nothing");
    }

    #[test]
    fn downsampling_halves() {
        let mut r = Resampler::new(48000.0, 24000.0);
        let mut out = Vec::new();
        r.process(&vec![0.5; 100], &mut out);
        assert_eq!(out.len(), 50);
    }
}
