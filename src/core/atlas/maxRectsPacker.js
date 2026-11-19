// The MaxRects packer the atlas places its frames with (and the twin page its rectangles): moved out of
// spriteSheetRegistry.js (SST-5) so the atlas worker imports it without the registry's graph. SpriteSheetRegistry.MaxRectsPacker
// is this class.

/**
 * MaxRectsPacker - Rectangle packing algorithm for texture atlas generation
 * Port of the MaxRects algorithm for efficient sprite packing
 */
export class MaxRectsPacker {
  constructor(width, height, padding = 0) {
    this.width = width;
    this.height = height;
    this.padding = padding;
    this.freeRects = [{ x: 0, y: 0, width, height }];
    /** The parts of the free rectangles a placement cut, before the prune (reused). */
    this._fresh = [];
    this._freshKeep = new Uint8Array(64);
  }

  insert(width, height, heuristic = 'best-short-side') {
    width += this.padding * 2;
    height += this.padding * 2;

    let bestRect = null;
    let bestScore = Infinity;
    let bestSecondaryScore = Infinity;

    for (let freeRect of this.freeRects) {
      if (freeRect.width >= width && freeRect.height >= height) {
        let score, secondaryScore;

        if (heuristic === 'best-short-side') {
          score = Math.min(freeRect.width - width, freeRect.height - height);
          secondaryScore = Math.max(freeRect.width - width, freeRect.height - height);
        } else if (heuristic === 'best-long-side') {
          score = Math.max(freeRect.width - width, freeRect.height - height);
          secondaryScore = Math.min(freeRect.width - width, freeRect.height - height);
        } else if (heuristic === 'best-area') {
          score = freeRect.width * freeRect.height - width * height;
          secondaryScore = Math.min(freeRect.width - width, freeRect.height - height);
        } else {
          // bottom-left
          score = freeRect.y;
          secondaryScore = freeRect.x;
        }

        if (score < bestScore || (score === bestScore && secondaryScore < bestSecondaryScore)) {
          bestRect = { x: freeRect.x, y: freeRect.y, width, height };
          bestScore = score;
          bestSecondaryScore = secondaryScore;
        }
      }
    }

    if (bestRect) {
      this.placeRect(bestRect);
      return {
        x: bestRect.x + this.padding,
        y: bestRect.y + this.padding,
        width: width - this.padding * 2,
        height: height - this.padding * 2,
      };
    }

    return null;
  }

  /**
   * The free rectangles the placed one overlaps give way to their parts outside it. The list holds no rectangle inside
   * another, so after a placement only those parts can be inside one: the prune tests them against the rest and each
   * other, not every pair (that was O(F²) a placement, 19 s of the Buenos Aires demo's load with 2 300 free rectangles).
   * The list comes out as the every-pair prune left it: the untouched rectangles in their order, then the parts that
   * stay in the order they were cut, so every frame lands where it did.
   */
  placeRect(rect) {
    const fresh = this._fresh;
    fresh.length = 0;
    const kept = [];
    const free = this.freeRects;
    for (let i = 0; i < free.length; i++) {
      if (!this.splitFreeNode(free[i], rect, fresh)) kept.push(free[i]);
    }
    this.freeRects = kept;
    this.pruneFresh(kept, fresh);
  }

  /** Appends to `kept` each of `fresh` that lies in none of `kept` and in no other of `fresh` (of two equal, the later). */
  pruneFresh(kept, fresh) {
    const n = fresh.length;
    if (n === 0) return;
    if (this._freshKeep.length < n) this._freshKeep = new Uint8Array(n * 2);
    const keep = this._freshKeep;
    const k = kept.length;
    for (let j = 0; j < n; j++) {
      const f = fresh[j];
      keep[j] = 1;
      for (let i = 0; i < k; i++) {
        if (this.isContainedIn(f, kept[i])) {
          keep[j] = 0;
          break;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!keep[j]) continue;
        if (this.isContainedIn(fresh[i], fresh[j])) {
          keep[i] = 0;
          break;
        }
        if (this.isContainedIn(fresh[j], fresh[i])) keep[j] = 0;
      }
    }
    for (let i = 0; i < n; i++) if (keep[i]) kept.push(fresh[i]);
  }

  /** Cuts `usedNode` out of `freeNode`: its parts go to `out`. False when they do not overlap. */
  splitFreeNode(freeNode, usedNode, out = this.freeRects) {
    if (
      usedNode.x >= freeNode.x + freeNode.width ||
      usedNode.x + usedNode.width <= freeNode.x ||
      usedNode.y >= freeNode.y + freeNode.height ||
      usedNode.y + usedNode.height <= freeNode.y
    ) {
      return false;
    }

    if (usedNode.x < freeNode.x + freeNode.width && usedNode.x + usedNode.width > freeNode.x) {
      if (usedNode.y > freeNode.y && usedNode.y < freeNode.y + freeNode.height) {
        let newNode = { ...freeNode };
        newNode.height = usedNode.y - newNode.y;
        out.push(newNode);
      }

      if (usedNode.y + usedNode.height < freeNode.y + freeNode.height) {
        let newNode = { ...freeNode };
        newNode.y = usedNode.y + usedNode.height;
        newNode.height = freeNode.y + freeNode.height - (usedNode.y + usedNode.height);
        out.push(newNode);
      }
    }

    if (usedNode.y < freeNode.y + freeNode.height && usedNode.y + usedNode.height > freeNode.y) {
      if (usedNode.x > freeNode.x && usedNode.x < freeNode.x + freeNode.width) {
        let newNode = { ...freeNode };
        newNode.width = usedNode.x - newNode.x;
        out.push(newNode);
      }

      if (usedNode.x + usedNode.width < freeNode.x + freeNode.width) {
        let newNode = { ...freeNode };
        newNode.x = usedNode.x + usedNode.width;
        newNode.width = freeNode.x + freeNode.width - (usedNode.x + usedNode.width);
        out.push(newNode);
      }
    }

    return true;
  }

  isContainedIn(a, b) {
    return (
      a.x >= b.x &&
      a.y >= b.y &&
      a.x + a.width <= b.x + b.width &&
      a.y + a.height <= b.y + b.height
    );
  }
}
