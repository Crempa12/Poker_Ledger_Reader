// libc++ std::sort, ported step for step: the sort the C++ app's Apple clang build uses.
//
// Equal keys can come out in a different order from a different sort routine, and that
// order is visible: which of two equal debts is paid first (settlement), which of two
// equal pairs is listed first (sessions), which of two equal dates comes first in a
// player's history (players). So the port follows libc++'s introsort exactly: sorting
// networks for up to 5 items, insertion sort below 24, a pattern-defeating quicksort
// above that, and heap sort when the depth limit runs out.
//
// Pure: sorts the array it is given, in place. Reads go through itemAt, so an index
// past the end throws rather than comparing undefined.

import { itemAt as at } from "./util.ts";

type Less<T> = (a: T, b: T) => boolean;

function swapAt<T>(a: T[], i: number, j: number): void {
  const t = at(a, i);
  a[i] = at(a, j);
  a[j] = t;
}

function sort3<T>(a: T[], x: number, y: number, z: number, c: Less<T>): void {
  if (!c(at(a, y), at(a, x))) {
    // x <= y
    if (!c(at(a, z), at(a, y))) return; // x <= y <= z
    swapAt(a, y, z);
    if (c(at(a, y), at(a, x))) swapAt(a, x, y);
    return;
  }
  // x > y
  if (c(at(a, z), at(a, y))) {
    swapAt(a, x, z);
    return;
  }
  swapAt(a, x, y);
  if (c(at(a, z), at(a, y))) swapAt(a, y, z);
}

function sort4<T>(a: T[], x1: number, x2: number, x3: number, x4: number, c: Less<T>): void {
  sort3(a, x1, x2, x3, c);
  if (c(at(a, x4), at(a, x3))) {
    swapAt(a, x3, x4);
    if (c(at(a, x3), at(a, x2))) {
      swapAt(a, x2, x3);
      if (c(at(a, x2), at(a, x1))) swapAt(a, x1, x2);
    }
  }
}

function sort5<T>(a: T[], x1: number, x2: number, x3: number, x4: number, x5: number, c: Less<T>): void {
  sort4(a, x1, x2, x3, x4, c);
  if (c(at(a, x5), at(a, x4))) {
    swapAt(a, x4, x5);
    if (c(at(a, x4), at(a, x3))) {
      swapAt(a, x3, x4);
      if (c(at(a, x3), at(a, x2))) {
        swapAt(a, x2, x3);
        if (c(at(a, x2), at(a, x1))) swapAt(a, x1, x2);
      }
    }
  }
}

// Insertion sort of [first, last). The inner loop stops at `first`, so it needs no
// sentinel before the range (the guarded version).
function insertionSort<T>(a: T[], first: number, last: number, c: Less<T>): void {
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (c(at(a, i), at(a, j))) {
      const t = at(a, i);
      let k = j;
      j = i;
      do {
        a[j] = at(a, k);
        j = k;
      } while (j !== first && c(t, at(a, --k)));
      a[j] = t;
    }
  }
}

// The same insertion sort for a range with an element before `first` that is no
// larger than anything in the range, so the inner loop needs no bounds check.
function insertionSortUnguarded<T>(a: T[], first: number, last: number, c: Less<T>): void {
  for (let i = first + 1; i !== last; i++) {
    let j = i - 1;
    if (c(at(a, i), at(a, j))) {
      const t = at(a, i);
      let k = j;
      j = i;
      do {
        a[j] = at(a, k);
        j = k;
      } while (c(t, at(a, --k)));
      a[j] = t;
    }
  }
}

// Insertion sort that gives up after 8 moves (returns false). Used on the two
// halves after a partition that already split them cleanly.
function insertionSortIncomplete<T>(a: T[], first: number, last: number, c: Less<T>): boolean {
  switch (last - first) {
    case 0:
    case 1:
      return true;
    case 2:
      if (c(at(a, last - 1), at(a, first))) swapAt(a, first, last - 1);
      return true;
    case 3:
      sort3(a, first, first + 1, last - 1, c);
      return true;
    case 4:
      sort4(a, first, first + 1, first + 2, last - 1, c);
      return true;
    case 5:
      sort5(a, first, first + 1, first + 2, first + 3, last - 1, c);
      return true;
  }
  let j = first + 2;
  sort3(a, first, first + 1, j, c);
  const limit = 8;
  let count = 0;
  for (let i = j + 1; i !== last; i++) {
    if (c(at(a, i), at(a, j))) {
      const t = at(a, i);
      let k = j;
      j = i;
      do {
        a[j] = at(a, k);
        j = k;
      } while (j !== first && c(t, at(a, --k)));
      a[j] = t;
      if (++count === limit) {
        i++;
        return i === last;
      }
    }
    j = i;
  }
  return true;
}

// Partition with the pivot's equals on the right. Returns the pivot's final
// position and whether the range was already partitioned.
function partitionWithEqualsOnRight<T>(
  a: T[],
  first0: number,
  last0: number,
  c: Less<T>,
): { pos: number; already: boolean } {
  const begin = first0;
  let first = first0;
  let last = last0;
  const pivot = at(a, begin);
  do {
    first++;
  } while (c(at(a, first), pivot));
  if (begin === first - 1) {
    while (first < last) {
      last--;
      if (c(at(a, last), pivot)) break;
    }
  } else {
    do {
      last--;
    } while (!c(at(a, last), pivot));
  }
  const already = first >= last;
  while (first < last) {
    swapAt(a, first, last);
    do {
      first++;
    } while (c(at(a, first), pivot));
    do {
      last--;
    } while (!c(at(a, last), pivot));
  }
  const pivotPos = first - 1;
  if (begin !== pivotPos) a[begin] = at(a, pivotPos);
  a[pivotPos] = pivot;
  return { pos: pivotPos, already };
}

// Partition with the pivot's equals on the left (used when the element before the
// range equals the pivot). Returns the start of the right-hand part.
function partitionWithEqualsOnLeft<T>(a: T[], first0: number, last0: number, c: Less<T>): number {
  const begin = first0;
  let first = first0;
  let last = last0;
  const pivot = at(a, begin);
  if (c(pivot, at(a, last - 1))) {
    do {
      first++;
    } while (!c(pivot, at(a, first)));
  } else {
    first++;
    while (first < last && !c(pivot, at(a, first))) first++;
  }
  if (first < last) {
    do {
      last--;
    } while (c(pivot, at(a, last)));
  }
  while (first < last) {
    swapAt(a, first, last);
    do {
      first++;
    } while (!c(pivot, at(a, first)));
    do {
      last--;
    } while (c(pivot, at(a, last)));
  }
  const pivotPos = first - 1;
  if (begin !== pivotPos) a[begin] = at(a, pivotPos);
  a[pivotPos] = pivot;
  return first;
}

function siftDown<T>(a: T[], first: number, len: number, start0: number, c: Less<T>): void {
  let start = start0;
  let child = start - first;
  if (len < 2 || Math.floor((len - 2) / 2) < child) return;
  child = 2 * child + 1;
  let childI = first + child;
  if (child + 1 < len && c(at(a, childI), at(a, childI + 1))) {
    childI++;
    child++;
  }
  if (c(at(a, childI), at(a, start))) return;
  const top = at(a, start);
  do {
    a[start] = at(a, childI);
    start = childI;
    if (Math.floor((len - 2) / 2) < child) break;
    child = 2 * child + 1;
    childI = first + child;
    if (child + 1 < len && c(at(a, childI), at(a, childI + 1))) {
      childI++;
      child++;
    }
  } while (!c(at(a, childI), top));
  a[start] = top;
}

// Sinks the top of a heap to the bottom along the larger children, then floats the
// element that was last back up (the libc++ "floyd" pop). Returns the hole.
function floydSiftDown<T>(a: T[], first: number, len: number, c: Less<T>): number {
  let hole = first;
  let childI = first;
  let child = 0;
  for (;;) {
    childI += child + 1;
    child = 2 * child + 1;
    if (child + 1 < len && c(at(a, childI), at(a, childI + 1))) {
      childI++;
      child++;
    }
    a[hole] = at(a, childI);
    hole = childI;
    if (child > Math.floor((len - 2) / 2)) return hole;
  }
}

function siftUp<T>(a: T[], first: number, last0: number, c: Less<T>, len0: number): void {
  let last = last0;
  let len = len0;
  if (len > 1) {
    len = Math.floor((len - 2) / 2);
    let ptr = first + len;
    last--;
    if (c(at(a, ptr), at(a, last))) {
      const t = at(a, last);
      do {
        a[last] = at(a, ptr);
        last = ptr;
        if (len === 0) break;
        len = Math.floor((len - 1) / 2);
        ptr = first + len;
      } while (c(at(a, ptr), t));
      a[last] = t;
    }
  }
}

function popHeap<T>(a: T[], first: number, last0: number, c: Less<T>, len: number): void {
  let last = last0;
  if (len > 1) {
    const top = at(a, first);
    let hole = floydSiftDown(a, first, len, c);
    last--;
    if (hole === last) {
      a[hole] = top;
    } else {
      a[hole] = at(a, last);
      hole++;
      a[last] = top;
      siftUp(a, first, hole, c, hole - first);
    }
  }
}

function makeHeap<T>(a: T[], first: number, last: number, c: Less<T>): void {
  const n = last - first;
  if (n > 1) {
    for (let start = Math.floor((n - 2) / 2); start >= 0; start--) siftDown(a, first, n, first + start, c);
  }
}

function sortHeap<T>(a: T[], first: number, last0: number, c: Less<T>): void {
  let last = last0;
  for (let n = last - first; n > 1; last--, n--) popHeap(a, first, last, c, n);
}

function introsort<T>(
  a: T[],
  first0: number,
  last0: number,
  c: Less<T>,
  depth0: number,
  leftmost0: boolean,
): void {
  let first = first0;
  let last = last0;
  let depth = depth0;
  let leftmost = leftmost0;
  const limit = 24; // insertion sort below this length
  const ninther = 128; // median of nine pivots above this length
  for (;;) {
    const len = last - first;
    switch (len) {
      case 0:
      case 1:
        return;
      case 2:
        if (c(at(a, last - 1), at(a, first))) swapAt(a, first, last - 1);
        return;
      case 3:
        sort3(a, first, first + 1, last - 1, c);
        return;
      case 4:
        sort4(a, first, first + 1, first + 2, last - 1, c);
        return;
      case 5:
        sort5(a, first, first + 1, first + 2, first + 3, last - 1, c);
        return;
    }
    if (len < limit) {
      if (leftmost) insertionSort(a, first, last, c);
      else insertionSortUnguarded(a, first, last, c);
      return;
    }
    if (depth === 0) {
      // Too many bad splits: heap sort guarantees n log n.
      makeHeap(a, first, last, c);
      sortHeap(a, first, last, c);
      return;
    }
    depth--;
    {
      const half = Math.floor(len / 2);
      if (len > ninther) {
        sort3(a, first, first + half, last - 1, c);
        sort3(a, first + 1, first + (half - 1), last - 2, c);
        sort3(a, first + 2, first + (half + 1), last - 3, c);
        sort3(a, first + (half - 1), first + half, first + (half + 1), c);
        swapAt(a, first, first + half);
      } else {
        sort3(a, first + half, first, last - 1, c);
      }
    }
    // When the element before this range equals the pivot, the equals go left and
    // the left side is already in place.
    if (!leftmost && !c(at(a, first - 1), at(a, first))) {
      first = partitionWithEqualsOnLeft(a, first, last, c);
      continue;
    }
    const part = partitionWithEqualsOnRight(a, first, last, c);
    let i = part.pos;
    if (part.already) {
      const fs = insertionSortIncomplete(a, first, i, c);
      if (insertionSortIncomplete(a, i + 1, last, c)) {
        if (fs) return;
        last = i;
        continue;
      } else if (fs) {
        i++;
        first = i;
        continue;
      }
    }
    introsort(a, first, i, c, depth, leftmost);
    leftmost = false;
    first = i + 1;
  }
}

// std::sort(first, last, comp) on the range [lo, hi) of `a`, in place.
export function libcppSort<T>(a: T[], lo: number, hi: number, c: Less<T>): void {
  const len = hi - lo;
  if (len <= 0) return;
  const depth = 2 * (31 - Math.clz32(len)); // 2 * floor(log2(len))
  introsort(a, lo, hi, c, depth, true);
}
