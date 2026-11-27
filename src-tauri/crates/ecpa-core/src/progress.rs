use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct ProgressThrottle {
    last: Option<Instant>,
}

impl ProgressThrottle {
    pub(crate) fn ready(&mut self, now: Instant, finished: bool) -> bool {
        if finished
            || self
                .last
                .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(100))
        {
            self.last = Some(now);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttles_chunks_but_keeps_first_and_final_progress() {
        let mut throttle = ProgressThrottle::default();
        let now = Instant::now();
        assert!(throttle.ready(now, false));
        assert!(!throttle.ready(now + Duration::from_millis(10), false));
        assert!(throttle.ready(now + Duration::from_millis(100), false));
        assert!(throttle.ready(now + Duration::from_millis(101), true));
    }
}
