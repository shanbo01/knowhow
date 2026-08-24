use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Result, anyhow};
use parking_lot::Mutex;

use crate::{model::Bounds, platform::MonitorDescriptor};

const RING_CAPACITY: usize = 4;
const FRAME_MAX_AGE: Duration = Duration::from_millis(750);
const FRAME_THROTTLE: Duration = Duration::from_millis(75);

#[derive(Clone, Debug)]
pub struct DesktopFrame {
    pub captured_at: Instant,
    pub monitor_bounds: Bounds,
    pub width: u32,
    pub height: u32,
    pub bgra: Arc<Vec<u8>>,
}

#[derive(Default)]
struct FrameRing {
    frames: VecDeque<DesktopFrame>,
}

impl FrameRing {
    fn push(&mut self, frame: DesktopFrame) {
        self.frames.push_back(frame);
        while self.frames.len() > RING_CAPACITY {
            self.frames.pop_front();
        }
    }

    fn newest_eligible(&self, action_at: Instant) -> Option<DesktopFrame> {
        self.frames
            .iter()
            .rev()
            .find(|frame| {
                frame.captured_at <= action_at
                    && action_at.duration_since(frame.captured_at) <= FRAME_MAX_AGE
            })
            .cloned()
            .or_else(|| self.frames.back().cloned())
    }

    fn latest(&self) -> Option<DesktopFrame> {
        self.frames.back().cloned()
    }
}

pub struct FrameHub {
    rings: Arc<HashMap<String, Arc<Mutex<FrameRing>>>>,
    stop: Arc<AtomicBool>,
    joins: Vec<JoinHandle<()>>,
}

impl FrameHub {
    pub fn start(
        monitors: Vec<MonitorDescriptor>,
        status: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self> {
        if monitors.is_empty() {
            return Err(anyhow!("Windows did not report an eligible display."));
        }
        let rings = Arc::new(
            monitors
                .iter()
                .map(|monitor| {
                    (
                        monitor.id.clone(),
                        Arc::new(Mutex::new(FrameRing::default())),
                    )
                })
                .collect::<HashMap<_, _>>(),
        );
        let stop = Arc::new(AtomicBool::new(false));
        let mut joins = Vec::with_capacity(monitors.len());
        for monitor in monitors {
            let ring = rings
                .get(&monitor.id)
                .cloned()
                .ok_or_else(|| anyhow!("display frame buffer is unavailable"))?;
            let thread_stop = Arc::clone(&stop);
            let thread_status = Arc::clone(&status);
            joins.push(
                thread::Builder::new()
                    .name(format!("knowhow-dxgi-{}", monitor.index))
                    .spawn(move || capture_monitor(monitor, ring, thread_stop, thread_status))?,
            );
        }
        Ok(Self { rings, stop, joins })
    }

    pub fn newest_before(&self, monitor_id: &str, action_at: Instant) -> Option<DesktopFrame> {
        self.rings
            .get(monitor_id)
            .and_then(|ring| ring.lock().newest_eligible(action_at))
    }

    pub fn latest(&self, monitor_id: &str) -> Option<DesktopFrame> {
        self.rings
            .get(monitor_id)
            .and_then(|ring| ring.lock().latest())
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for join in self.joins.drain(..) {
            let _ = join.join();
        }
        for ring in self.rings.values() {
            ring.lock().frames.clear();
        }
    }
}

impl Drop for FrameHub {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
fn capture_monitor(
    monitor: MonitorDescriptor,
    ring: Arc<Mutex<FrameRing>>,
    stop: Arc<AtomicBool>,
    status: Arc<dyn Fn(String) + Send + Sync>,
) {
    use dxgi_capture_rs::{CaptureError, DXGIManager};

    while !stop.load(Ordering::Acquire) {
        let mut manager = match DXGIManager::new(75) {
            Ok(manager) => manager,
            Err(_) => {
                status("Display capture is temporarily unavailable. Retrying…".to_owned());
                thread::sleep(Duration::from_millis(500));
                continue;
            }
        };
        manager.set_capture_source_index(monitor.index);
        let mut protected_content_notified = false;
        while !stop.load(Ordering::Acquire) {
            match manager.capture_frame_components_with_metadata() {
                Ok((pixels, (width, height), metadata)) => {
                    if metadata.protected_content_masked_out {
                        // DXGI has already replaced protected pixels in this frame. Discarding
                        // the whole frame here would let a content-protected KnowHow HUD starve
                        // the pre-action ring and prevent every display click from being captured.
                        if !protected_content_notified {
                            status("Protected display content is masked.".to_owned());
                            protected_content_notified = true;
                        }
                    }
                    let (Ok(width), Ok(height)) = (u32::try_from(width), u32::try_from(height))
                    else {
                        status("The display dimensions are unsupported.".to_owned());
                        continue;
                    };
                    ring.lock().push(DesktopFrame {
                        captured_at: Instant::now(),
                        monitor_bounds: monitor.bounds,
                        width,
                        height,
                        bgra: Arc::new(pixels),
                    });
                    // Keeping a short pre-action ring does not require copying the full desktop
                    // at the display refresh rate. This caps CPU and memory bandwidth while still
                    // leaving a recent frame available for every hardware input event.
                    thread::sleep(FRAME_THROTTLE);
                }
                Err(CaptureError::Timeout) => {}
                Err(CaptureError::AccessLost | CaptureError::RefreshFailure) => {
                    status("Display changed. Reconnecting capture…".to_owned());
                    break;
                }
                Err(CaptureError::AccessDenied) => {
                    ring.lock().frames.clear();
                    status("Protected display content is excluded.".to_owned());
                    thread::sleep(Duration::from_millis(250));
                }
                Err(CaptureError::Fail(_)) => {
                    status("Graphics capture is recovering…".to_owned());
                    break;
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn capture_monitor(
    _monitor: MonitorDescriptor,
    _ring: Arc<Mutex<FrameRing>>,
    _stop: Arc<AtomicBool>,
    status: Arc<dyn Fn(String) + Send + Sync>,
) {
    status("KnowHow Capture supports Windows only.".to_owned());
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use super::{DesktopFrame, FrameRing};
    use crate::model::Bounds;

    fn frame(at: Instant) -> DesktopFrame {
        DesktopFrame {
            captured_at: at,
            monitor_bounds: Bounds {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
            width: 1,
            height: 1,
            bgra: Arc::new(vec![0, 0, 0, 255]),
        }
    }

    #[test]
    fn pointer_action_uses_newest_pre_action_frame() {
        let start = Instant::now();
        let mut ring = FrameRing::default();
        ring.push(frame(start));
        ring.push(frame(start + Duration::from_millis(20)));
        ring.push(frame(start + Duration::from_millis(40)));
        assert_eq!(
            ring.newest_eligible(start + Duration::from_millis(35))
                .map(|frame| frame.captured_at),
            Some(start + Duration::from_millis(20))
        );
    }

    #[test]
    fn ring_has_bounded_gpu_ram_mirror() {
        let start = Instant::now();
        let mut ring = FrameRing::default();
        for index in 0..12 {
            ring.push(frame(start + Duration::from_millis(index)));
        }
        assert_eq!(ring.frames.len(), 4);
    }
}
