def_val!(TickTimer { remaining: u32 });

impl TickTimer {
    pub const fn new(ticks: u32) -> Self {
        Self { remaining: ticks }
    }
    pub const fn done(&self) -> bool {
        self.remaining == 0
    }

    pub fn tick(&mut self) -> bool {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.remaining == 0
        } else {
            false
        }
    }

    pub fn reset(&mut self, ticks: u32) {
        self.remaining = ticks;
    }
}

pub const TICK_RATE: u32 = 30;
