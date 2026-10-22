// Production build: no hot reload (see ../hotReload.js).
export class HotReload {
  static SLOT = '__weed-hot-reload';
  static start() {}
  static stop() {}
  static async reloadKeepingState() {}
  static takeRestore() {
    return null;
  }
  static async readSlot() {
    return null;
  }
  static async discardSlot() {}
}
