// The bigAtlas packer as it was until the free-list prune tested only the rectangles a placement cuts: MaxRectsPacker
// (src/core/spriteSheetRegistry.js) at 40f5d2f3, whose pruneFreeList compared every pair of free rectangles after each
// placement. Kept as the parity reference the shipped packer is tested against (tests/node/atlasPack.test.js); the engine
// does not use it.

export class MaxRectsPackerReference {
  constructor(width, height, padding = 0) {
    this.width = width;
    this.height = height;
    this.padding = padding;
    this.freeRects = [{ x: 0, y: 0, width, height }];
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

  placeRect(rect) {
    // Mark rects for removal instead of splicing in loop (avoids O(n²) splices)
    const toKeep = [];
    for (let i = 0; i < this.freeRects.length; i++) {
      if (!this.splitFreeNode(this.freeRects[i], rect)) {
        toKeep.push(this.freeRects[i]);
      }
    }
    this.freeRects = toKeep;
    this.pruneFreeList();
  }

  splitFreeNode(freeNode, usedNode) {
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
        this.freeRects.push(newNode);
      }

      if (usedNode.y + usedNode.height < freeNode.y + freeNode.height) {
        let newNode = { ...freeNode };
        newNode.y = usedNode.y + usedNode.height;
        newNode.height = freeNode.y + freeNode.height - (usedNode.y + usedNode.height);
        this.freeRects.push(newNode);
      }
    }

    if (usedNode.y < freeNode.y + freeNode.height && usedNode.y + usedNode.height > freeNode.y) {
      if (usedNode.x > freeNode.x && usedNode.x < freeNode.x + freeNode.width) {
        let newNode = { ...freeNode };
        newNode.width = usedNode.x - newNode.x;
        this.freeRects.push(newNode);
      }

      if (usedNode.x + usedNode.width < freeNode.x + freeNode.width) {
        let newNode = { ...freeNode };
        newNode.x = usedNode.x + usedNode.width;
        newNode.width = freeNode.x + freeNode.width - (usedNode.x + usedNode.width);
        this.freeRects.push(newNode);
      }
    }

    return true;
  }

  pruneFreeList() {
    // Mark contained rects for removal (avoids O(n²) splice operations)
    const len = this.freeRects.length;
    const keep = new Array(len).fill(true);

    for (let i = 0; i < len; i++) {
      if (!keep[i]) continue;
      for (let j = i + 1; j < len; j++) {
        if (!keep[j]) continue;
        if (this.isContainedIn(this.freeRects[i], this.freeRects[j])) {
          keep[i] = false;
          break;
        }
        if (this.isContainedIn(this.freeRects[j], this.freeRects[i])) {
          keep[j] = false;
        }
      }
    }

    // Single pass to rebuild array
    const newFreeRects = [];
    for (let i = 0; i < len; i++) {
      if (keep[i]) newFreeRects.push(this.freeRects[i]);
    }
    this.freeRects = newFreeRects;
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
