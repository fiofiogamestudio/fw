use crate::{Fixed, Vec2f, Vec2i};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct AoiGrid {
    trunk_size_tiles: i32,
    radius_trunks: i32,
}

impl AoiGrid {
    pub fn new(trunk_size_tiles: i32, radius_trunks: i32) -> Self {
        assert!(trunk_size_tiles > 0, "trunk_size_tiles must be > 0");
        assert!(radius_trunks >= 0, "radius_trunks must be >= 0");
        Self {
            trunk_size_tiles,
            radius_trunks,
        }
    }

    pub fn trunk_size_tiles(self) -> i32 {
        self.trunk_size_tiles
    }

    pub fn radius_trunks(self) -> i32 {
        self.radius_trunks
    }

    pub fn coord_from_tile(self, tile: Vec2i) -> Vec2i {
        Vec2i::new(
            tile.x.div_euclid(self.trunk_size_tiles),
            tile.y.div_euclid(self.trunk_size_tiles),
        )
    }

    pub fn coord_from_world(self, pos: Vec2f) -> Vec2i {
        let tile = Vec2i::new(
            pos.x.raw() >> Fixed::FRAC_BITS,
            pos.y.raw() >> Fixed::FRAC_BITS,
        );
        self.coord_from_tile(tile)
    }

    pub fn contains(self, center: Vec2i, candidate: Vec2i) -> bool {
        let dx = (candidate.x - center.x).abs();
        let dy = (candidate.y - center.y).abs();
        dx <= self.radius_trunks && dy <= self.radius_trunks
    }

    pub fn aoi_coords(self, center: Vec2i) -> Vec<Vec2i> {
        let mut coords = Vec::new();
        for y in (center.y - self.radius_trunks)..=(center.y + self.radius_trunks) {
            for x in (center.x - self.radius_trunks)..=(center.x + self.radius_trunks) {
                coords.push(Vec2i::new(x, y));
            }
        }
        coords
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coord_from_world_uses_tile_space_division() {
        let grid = AoiGrid::new(16, 1);
        let coord = grid.coord_from_world(Vec2f::from_tile(17, 33));

        assert_eq!(coord, Vec2i::new(1, 2));
    }

    #[test]
    fn aoi_coords_cover_center_and_ring() {
        let grid = AoiGrid::new(16, 1);
        let coords = grid.aoi_coords(Vec2i::new(4, 8));

        assert_eq!(coords.len(), 9);
        assert!(coords.contains(&Vec2i::new(4, 8)));
        assert!(coords.contains(&Vec2i::new(3, 7)));
        assert!(coords.contains(&Vec2i::new(5, 9)));
        assert!(!coords.contains(&Vec2i::new(6, 8)));
    }
}
