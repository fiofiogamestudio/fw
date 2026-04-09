def_id!(Fixed(i32));

impl Fixed {
    pub const ZERO: Self = Self(0);
    pub const ONE: Self = Self(Self::SCALE);
    pub const FRAC_BITS: u32 = 8;
    pub const SCALE: i32 = 1 << Self::FRAC_BITS;
    pub const SYNC_PER_TILE: i32 = 16;
    pub const RAW_PER_SYNC: i32 = Self::SCALE / Self::SYNC_PER_TILE;

    pub const fn from_tile(tiles: i32) -> Self {
        Self(tiles * Self::SCALE)
    }

    pub const fn from_tile_frac(num: i32, den: i32) -> Self {
        Self(num * Self::SCALE / den)
    }

    pub fn from_f32(v: f32) -> Self {
        Self((v * Self::SCALE as f32) as i32)
    }

    pub fn to_f32(self) -> f32 {
        self.0 as f32 / Self::SCALE as f32
    }

    pub const fn to_sync(self) -> i32 {
        self.0 / Self::RAW_PER_SYNC
    }

    pub const fn from_sync(s: i32) -> Self {
        Self(s * Self::RAW_PER_SYNC)
    }

    pub const fn raw(self) -> i32 {
        self.0
    }

    pub const fn from_raw(r: i32) -> Self {
        Self(r)
    }

    pub const fn abs(self) -> Self {
        if self.0 < 0 { Self(-self.0) } else { self }
    }

    pub const fn mul(self, rhs: Self) -> Self {
        Self(((self.0 as i64 * rhs.0 as i64) >> Self::FRAC_BITS) as i32)
    }

    pub const fn div(self, rhs: Self) -> Self {
        if rhs.0 == 0 {
            return Self::ZERO;
        }
        Self((((self.0 as i64) << Self::FRAC_BITS) / rhs.0 as i64) as i32)
    }

    pub fn sqrt(self) -> Self {
        if self.0 <= 0 {
            return Self::ZERO;
        }
        let val = (self.0 as i64) << Self::FRAC_BITS;
        let mut x = val;
        let mut y = (x + 1) >> 1;
        while y < x {
            x = y;
            y = (x + val / x) >> 1;
        }
        Self(x as i32)
    }

    pub const fn signum(self) -> Self {
        if self.0 > 0 {
            Self(Self::SCALE)
        } else if self.0 < 0 {
            Self(-Self::SCALE)
        } else {
            Self::ZERO
        }
    }
}

impl std::ops::Add for Fixed {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0)
    }
}

impl std::ops::AddAssign for Fixed {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += rhs.0;
    }
}

impl std::ops::Sub for Fixed {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0)
    }
}

impl std::ops::SubAssign for Fixed {
    fn sub_assign(&mut self, rhs: Self) {
        self.0 -= rhs.0;
    }
}

impl std::ops::Neg for Fixed {
    type Output = Self;
    fn neg(self) -> Self {
        Self(-self.0)
    }
}

impl std::ops::Mul<i32> for Fixed {
    type Output = Self;
    fn mul(self, rhs: i32) -> Self {
        Self(self.0 * rhs)
    }
}

impl std::ops::Mul<Fixed> for i32 {
    type Output = Fixed;
    fn mul(self, rhs: Fixed) -> Fixed {
        Fixed(self * rhs.0)
    }
}

impl std::ops::Div<i32> for Fixed {
    type Output = Self;
    fn div(self, rhs: i32) -> Self {
        Self(self.0 / rhs)
    }
}
