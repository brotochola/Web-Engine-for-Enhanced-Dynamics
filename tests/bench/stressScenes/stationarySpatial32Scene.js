import { StationarySpatialScene } from './stationarySpatialScene.js';

export class StationarySpatial32Scene extends StationarySpatialScene {
  static config = { ...StationarySpatialScene.config, entityIdWidth: 32 };
}
