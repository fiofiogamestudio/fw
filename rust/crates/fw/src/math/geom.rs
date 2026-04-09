def_val!(Vec2i { x: i32, y: i32 });

impl Vec2i {
    pub const ZERO: Self = Self { x: 0, y: 0 };
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
    pub const fn len_sq(self) -> i64 {
        (self.x as i64) * (self.x as i64) + (self.y as i64) * (self.y as i64)
    }
}

impl std::ops::Add for Vec2i {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl std::ops::Sub for Vec2i {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl std::ops::Neg for Vec2i {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y)
    }
}

impl std::ops::Mul<i32> for Vec2i {
    type Output = Self;
    fn mul(self, s: i32) -> Self {
        Self::new(self.x * s, self.y * s)
    }
}

def_val!(Aabb {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32
});

impl Aabb {
    pub const fn new(min_x: i32, min_y: i32, max_x: i32, max_y: i32) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    pub const fn from_center(c: Vec2i, hw: i32, hh: i32) -> Self {
        Self {
            min_x: c.x - hw,
            min_y: c.y - hh,
            max_x: c.x + hw,
            max_y: c.y + hh,
        }
    }

    pub const fn overlaps(&self, o: &Aabb) -> bool {
        self.min_x < o.max_x && self.max_x > o.min_x && self.min_y < o.max_y && self.max_y > o.min_y
    }

    pub const fn contains(&self, p: Vec2i) -> bool {
        p.x >= self.min_x && p.x < self.max_x && p.y >= self.min_y && p.y < self.max_y
    }
}

def_enum!(Dir4 {
    Up,
    Down,
    Left,
    Right
});

impl Dir4 {
    pub const fn to_vec(self) -> Vec2i {
        match self {
            Dir4::Up => Vec2i::new(0, -1),
            Dir4::Down => Vec2i::new(0, 1),
            Dir4::Left => Vec2i::new(-1, 0),
            Dir4::Right => Vec2i::new(1, 0),
        }
    }
}
