// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// libfvad-backed voice activity detection for live-voice barge-in gating.
//
// Built only when the `vad` cargo feature is enabled (default OFF). libfvad
// is a C library wrapped by the `webrtc-vad` Rust crate; pulling it into
// every native build would add a C-compiler dependency and ~30-60s of clean
// build time for every contributor regardless of whether they touch voice.
// The feature flag keeps Phase 0/1/2 builds fast.
//
// API contract: `is_speech_frame_16khz` accepts a slice of 10/20/30ms worth
// of i16 PCM samples at 16kHz (160 / 320 / 480 samples) and returns true
// iff libfvad classifies it as speech. Any other length errors out; the TS
// wrapper splits a longer mic chunk into 20ms sub-frames and ORs the result.
//
// Modes 0-3 trade quality for restrictiveness (0=most permissive, 3=most
// aggressive). Mode 2 ("aggressive") is the default — empirically best fit
// for Bhai's barge-in use case where false positives (interrupting Bhai
// for room noise) cost more than false negatives (missing a quiet barge-in).

#![cfg(feature = "vad")]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

/// Map u8 aggressiveness (0-3) to the crate's `VadMode` enum.
fn mode_from_u8(level: u8) -> VadMode {
    match level {
        0 => VadMode::Quality,
        1 => VadMode::LowBitrate,
        2 => VadMode::Aggressive,
        _ => VadMode::VeryAggressive,
    }
}

/// Classify a single 10/20/30ms frame of 16kHz mono i16 PCM as speech or not.
///
/// `pcm` must be a `Buffer` of exactly 320 (10ms), 640 (20ms), or 960 (30ms)
/// bytes — i.e. 160/320/480 i16 samples little-endian. Any other length
/// throws. `aggressiveness` is 0-3.
///
/// We instantiate a fresh `Vad` per call. libfvad's state is small (~hundreds
/// of bytes) and per-call construction lets the JS caller change modes
/// dynamically without holding a handle. The construction cost is ~1-5μs
/// per call which is negligible at 50Hz (frame rate).
#[napi]
pub fn is_speech_frame_16khz(pcm: Buffer, aggressiveness: u8) -> Result<bool> {
    if pcm.len() % 2 != 0 {
        return Err(Error::from_reason(
            "PCM buffer length must be even (i16 samples)",
        ));
    }
    let sample_count = pcm.len() / 2;
    if !matches!(sample_count, 160 | 320 | 480) {
        return Err(Error::from_reason(format!(
            "frame must be 160/320/480 samples (10/20/30 ms @ 16kHz); got {sample_count}"
        )));
    }
    // Decode little-endian i16 into a Vec — libfvad needs an i16 slice.
    let mut samples: Vec<i16> = Vec::with_capacity(sample_count);
    for chunk in pcm.chunks_exact(2) {
        samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }

    let mut vad =
        Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, mode_from_u8(aggressiveness));
    match vad.is_voice_segment(&samples) {
        Ok(speech) => Ok(speech),
        // libfvad rejected the frame shape — exposed as a TS-side error rather
        // than a silent false (fail-loud so the caller can see misuse).
        Err(_) => Err(Error::from_reason("libfvad rejected the frame")),
    }
}

/// Convenience: scan a longer 16kHz PCM chunk by splitting it into 20ms
/// sub-frames and returning true if ANY sub-frame is classified as speech.
/// `pcm` may be any length that's a multiple of 640 bytes (20ms × 16kHz × 2
/// bytes/sample). The 100ms mic chunks Bhai uses are 3200 bytes = 5 frames.
///
/// Returning early on the first speech-positive frame minimizes per-chunk
/// cost in the common silent-chunk case.
#[napi]
pub fn any_speech_frame_16khz(pcm: Buffer, aggressiveness: u8) -> Result<bool> {
    if pcm.len() % 640 != 0 {
        return Err(Error::from_reason(format!(
            "chunk must be a multiple of 640 bytes (20ms frames); got {} bytes",
            pcm.len()
        )));
    }

    let mut vad =
        Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, mode_from_u8(aggressiveness));

    for frame_bytes in pcm.chunks_exact(640) {
        let mut samples: Vec<i16> = Vec::with_capacity(320);
        for chunk in frame_bytes.chunks_exact(2) {
            samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
        }
        match vad.is_voice_segment(&samples) {
            Ok(true) => return Ok(true),
            Ok(false) => continue,
            Err(_) => return Err(Error::from_reason("libfvad rejected a sub-frame")),
        }
    }
    Ok(false)
}
