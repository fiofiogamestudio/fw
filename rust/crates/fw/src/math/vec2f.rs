use crate::math::fixed::Fixed;
use crate::math::geom::Vec2i;

def_val!(Vec2f { x: Fixed, y: Fixed });

impl Vec2f {
    pub const ZERO: Self = Self {
        x: Fixed::ZERO,
        y: Fixed::ZERO,
    };

    pub const fn new(x: Fixed, y: Fixed) -> Self {
        Self { x, y }
    }

    pub const fn from_tile(x: i32, y: i32) -> Self {
        Self {
            x: Fixed::from_tile(x),
            y: Fixed::from_tile(y),
        }
    }

    pub fn from_f32(x: f32, y: f32) -> Self {
        Self {
            x: Fixed::from_f32(x),
            y: Fixed::from_f32(y),
        }
    }

    pub fn to_sync(self) -> Vec2i {
        Vec2i::new(self.x.to_sync(), self.y.to_sync())
    }

    pub fn from_sync(v: Vec2i) -> Self {
        Self {
            x: Fixed::from_sync(v.x),
            y: Fixed::from_sync(v.y),
        }
    }

    pub fn from_dir_input(v: Vec2i) -> Self {
        Self {
            x: Fixed::from_tile(v.x.signum()),
            y: Fixed::from_tile(v.y.signum()),
        }
    }

    pub fn from_aim_input(v: Vec2i) -> Self {
        Self {
            x: Fixed::from_raw(v.x),
            y: Fixed::from_raw(v.y),
        }
    }

    pub fn len_sq(self) -> i64 {
        (self.x.0 as i64) * (self.x.0 as i64) + (self.y.0 as i64) * (self.y.0 as i64)
    }

    pub fn len(self) -> Fixed {
        if self.x.0 == 0 && self.y.0 == 0 {
            return Fixed::ZERO;
        }
        let sq = self.len_sq();
        let mut x = sq;
        let mut y = (x + 1) >> 1;
        while y < x {
            x = y;
            y = (x + sq / x) >> 1;
        }
        Fixed(x as i32)
    }

    pub fn normalized(self) -> Self {
        let l = self.len();
        if l.0 == 0 {
            return Self::ZERO;
        }
        Self {
            x: self.x.div(l),
            y: self.y.div(l),
        }
    }

    pub fn scale(self, s: Fixed) -> Self {
        Self {
            x: self.x.mul(s),
            y: self.y.mul(s),
        }
    }

    pub fn scale_i(self, s: i32) -> Self {
        Self {
            x: self.x * s,
            y: self.y * s,
        }
    }

    pub fn dot(self, rhs: Self) -> Fixed {
        self.x.mul(rhs.x) + self.y.mul(rhs.y)
    }

    pub fn is_zero(self) -> bool {
        self.x.0 == 0 && self.y.0 == 0
    }
}

impl std::ops::Add for Vec2f {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self {
            x: self.x + rhs.x,
            y: self.y + rhs.y,
        }
    }
}

impl std::ops::AddAssign for Vec2f {
    fn add_assign(&mut self, rhs: Self) {
        self.x += rhs.x;
        self.y += rhs.y;
    }
}

impl std::ops::Sub for Vec2f {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self {
            x: self.x - rhs.x,
            y: self.y - rhs.y,
        }
    }
}

impl std::ops::Neg for Vec2f {
    type Output = Self;
    fn neg(self) -> Self {
        Self {
            x: -self.x,
            y: -self.y,
        }
    }
}
