/*
 * ds.js — the data-structure core of Reel Maker Studio.
 *
 * Every structure here is a JavaScript port of one of the DSLAB experiments
 * in the root of this repository. The studio's features are built directly
 * on top of them, so the lab work is what actually runs the editor.
 *
 *   Experiment 1      Array insert / delete / display   -> MediaLibrary
 *   Experiment 2      Linear search                     -> library search box
 *   Experiment 3      Binary search                     -> clip under the playhead
 *   Experiment 4      Doubly linked list                -> the Timeline
 *   Experiment 5      Stack (push / pop / display)      -> Undo / Redo
 *   Experiment 6      Infix -> postfix with a stack     -> math in number fields ("2*1.5+.5")
 *   Experiment 7      Linked-list queue (front/rear)    -> AI generation queue
 *   Experiment 8      Insertion sort                    -> sort library by "Newest"
 *   Experiment 9      Quick sort                        -> sort library by "Duration"
 *   Experiment 10     Merge sort                        -> sort library by "Name"
 *   Experiment 11     Binary search tree                -> hashtag suggestions
 *   Experiment 12     Heap sort (max-heapify)           -> sort library by "File size"
 *   Experiment 13.1   BFS with a queue                  -> Auto-reel: story order of scenes
 *   Experiment 13.2   DFS with a stack                  -> Auto-reel: alternate "deep dive" order
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
   * Experiment 1 + 2 — array with insert / delete / linear search
   * ------------------------------------------------------------------- */
  class MediaLibrary {
    constructor() { this.a = []; }
    get n() { return this.a.length; }
    // Exp 1, case 1: insert at position (shift right)
    insert(pos, ele) {
      if (pos < 0 || pos > this.a.length) pos = this.a.length;
      for (let i = this.a.length; i > pos; i--) this.a[i] = this.a[i - 1];
      this.a[pos] = ele;
    }
    push(ele) { this.insert(this.a.length, ele); }
    // Exp 1, case 2: delete at position (shift left)
    deleteAt(pos) {
      if (pos < 0 || pos >= this.a.length) return null;
      const removed = this.a[pos];
      for (let i = pos; i < this.a.length - 1; i++) this.a[i] = this.a[i + 1];
      this.a.length -= 1;
      return removed;
    }
    removeById(id) { return this.deleteAt(this.indexOf(id)); }
    // Exp 2: linear search
    indexOf(id) {
      for (let i = 0; i < this.a.length; i++) if (this.a[i].id === id) return i;
      return -1;
    }
    get(id) { const i = this.indexOf(id); return i < 0 ? null : this.a[i]; }
    linearSearch(query) {
      const q = query.trim().toLowerCase();
      if (!q) return this.a.slice();
      const out = [];
      for (let i = 0; i < this.a.length; i++) {
        const hay = (this.a[i].name + ' ' + (this.a[i].prompt || '') + ' ' + this.a[i].kind).toLowerCase();
        if (hay.indexOf(q) !== -1) out.push(this.a[i]);
      }
      return out;
    }
    display() { return this.a.slice(); }
  }

  /* ---------------------------------------------------------------------
   * Experiment 3 — binary search
   * Finds which clip is on screen at time t, given sorted clip start times.
   * ------------------------------------------------------------------- */
  function binarySearchStart(starts, t) {
    let min = 0, max = starts.length - 1, ans = -1;
    while (min <= max) {
      const mid = (min + max) >> 1;
      if (starts[mid] <= t) { ans = mid; min = mid + 1; } else { max = mid - 1; }
    }
    return ans;
  }

  /* ---------------------------------------------------------------------
   * Experiment 4 — doubly linked list (head / tail, prev / next)
   * The timeline is an ordered chain of clips. Reordering, splitting and
   * inserting are O(1) pointer updates once you hold the node.
   * ------------------------------------------------------------------- */
  class TLNode {
    constructor(info) { this.info = info; this.prev = null; this.next = null; }
  }
  class Timeline {
    constructor() { this.head = null; this.tail = null; this.size = 0; }
    static createnode(info) { return new TLNode(info); }

    insertEnd(info) {
      const p = Timeline.createnode(info);
      if (!this.head) { this.head = this.tail = p; }
      else { this.tail.next = p; p.prev = this.tail; this.tail = p; }
      this.size++;
      return p;
    }
    insertBeg(info) {
      const p = Timeline.createnode(info);
      if (!this.head) { this.head = this.tail = p; }
      else { p.next = this.head; this.head.prev = p; this.head = p; }
      this.size++;
      return p;
    }
    insertAfter(node, info) {
      if (!node || node === this.tail) return this.insertEnd(info);
      const p = Timeline.createnode(info);
      p.prev = node; p.next = node.next;
      node.next.prev = p; node.next = p;
      this.size++;
      return p;
    }
    // unlink a node without freeing it (used by delete and move)
    unlink(node) {
      if (node.prev) node.prev.next = node.next; else this.head = node.next;
      if (node.next) node.next.prev = node.prev; else this.tail = node.prev;
      node.prev = node.next = null;
      this.size--;
      return node;
    }
    deletion(id) {
      const node = this.searching(id);
      return node ? this.unlink(node).info : null;
    }
    searching(id) {
      for (let p = this.head; p; p = p.next) if (p.info.id === id) return p;
      return null;
    }
    // move node so it sits at index `to` (0-based) in the final list
    moveTo(id, to) {
      const node = this.searching(id);
      if (!node) return;
      this.unlink(node);
      if (to <= 0 || !this.head) {
        node.next = this.head;
        if (this.head) this.head.prev = node; else this.tail = node;
        this.head = node;
      } else {
        let p = this.head, i = 0;
        while (p.next && i < to - 1) { p = p.next; i++; }
        node.prev = p; node.next = p.next;
        if (p.next) p.next.prev = node; else this.tail = node;
        p.next = node;
      }
      this.size++;
    }
    indexOf(id) {
      let i = 0;
      for (let p = this.head; p; p = p.next, i++) if (p.info.id === id) return i;
      return -1;
    }
    display() {
      const out = [];
      for (let p = this.head; p; p = p.next) out.push(p.info);
      return out;
    }
    clear() { this.head = this.tail = null; this.size = 0; }
    fromArray(arr) { this.clear(); arr.forEach((x) => this.insertEnd(x)); }
  }

  /* ---------------------------------------------------------------------
   * Experiment 5 — stack (array + top)
   * Two stacks give Undo / Redo of whole-project snapshots.
   * ------------------------------------------------------------------- */
  class Stack {
    constructor(max = 100) { this.a = []; this.top = -1; this.max = max; }
    push(x) {
      if (this.top === this.max - 1) { this.a.shift(); this.top--; } // overflow: drop oldest
      this.a[++this.top] = x;
    }
    pop() { if (this.top === -1) return undefined; const x = this.a[this.top]; this.a.length = this.top--; return x; }
    peek() { return this.top === -1 ? undefined : this.a[this.top]; }
    isEmpty() { return this.top === -1; }
    clear() { this.a = []; this.top = -1; }
    display() { return this.a.slice(0, this.top + 1); }
  }
  class History {
    constructor(max = 80) { this.undoStack = new Stack(max); this.redoStack = new Stack(max); }
    record(snapshot) { this.undoStack.push(snapshot); this.redoStack.clear(); }
    undo(current) {
      if (this.undoStack.isEmpty()) return null;
      this.redoStack.push(current);
      return this.undoStack.pop();
    }
    redo(current) {
      if (this.redoStack.isEmpty()) return null;
      this.undoStack.push(current);
      return this.redoStack.pop();
    }
    get canUndo() { return !this.undoStack.isEmpty(); }
    get canRedo() { return !this.redoStack.isEmpty(); }
  }

  /* ---------------------------------------------------------------------
   * Experiment 6 — infix to postfix with an operator stack, then evaluate.
   * Lets any number field accept "3+2.5", "(4-1)*1.5", "2^2" — no eval().
   * ------------------------------------------------------------------- */
  function priority(p) {
    if (p === '(') return 0;
    if (p === '+' || p === '-') return 1;
    if (p === '*' || p === '/') return 2;
    if (p === '^') return 3;
    return -1;
  }
  function infixToPostfix(expr) {
    const out = []; const st = new Stack(64);
    const tokens = String(expr).replace(/\s+/g, '').match(/\d*\.?\d+|[()+\-*/^]/g) || [];
    let prev = null;
    for (const tk of tokens) {
      if (/^\d*\.?\d+$/.test(tk)) out.push(parseFloat(tk));
      else if (tk === '(') st.push(tk);
      else if (tk === ')') {
        while (!st.isEmpty() && st.peek() !== '(') out.push(st.pop());
        st.pop();
      } else {
        if (tk === '-' && (prev === null || /[(+\-*/^]/.test(prev))) { out.push(0); } // unary minus
        while (!st.isEmpty() && priority(st.peek()) >= priority(tk) && tk !== '^') out.push(st.pop());
        st.push(tk);
      }
      prev = tk;
    }
    while (!st.isEmpty()) out.push(st.pop());
    return out;
  }
  function evalPostfix(post) {
    const st = new Stack(64);
    for (const tk of post) {
      if (typeof tk === 'number') { st.push(tk); continue; }
      const b = st.pop(), a = st.pop();
      if (a === undefined || b === undefined) return NaN;
      st.push(tk === '+' ? a + b : tk === '-' ? a - b : tk === '*' ? a * b : tk === '/' ? a / b : Math.pow(a, b));
    }
    const r = st.pop();
    return st.isEmpty() && typeof r === 'number' ? r : NaN;
  }
  function evaluate(expr) { return evalPostfix(infixToPostfix(expr)); }

  /* ---------------------------------------------------------------------
   * Experiment 7 — queue as a linked list (front / rear)
   * AI generation jobs are processed first-in, first-out.
   * ------------------------------------------------------------------- */
  class Queue {
    constructor() { this.front = null; this.rear = null; this.length = 0; }
    enqueue(info) {
      const node = { info, next: null };
      if (!this.rear) this.front = this.rear = node;
      else { this.rear.next = node; this.rear = node; }
      this.length++;
    }
    dequeue() {
      if (!this.front) return null;
      const node = this.front;
      this.front = node.next;
      if (!this.front) this.rear = null;
      this.length--;
      return node.info;
    }
    isEmpty() { return this.front === null; }
    display() { const out = []; for (let p = this.front; p; p = p.next) out.push(p.info); return out; }
  }

  /* ---------------------------------------------------------------------
   * Experiments 8, 9, 10, 12 — sorting the media library
   * Each takes an array and a key function and returns a new sorted array.
   * ------------------------------------------------------------------- */
  // Exp 8 — insertion sort
  function insertionSort(arr, key) {
    const a = arr.slice();
    for (let i = 1; i < a.length; i++) {
      const m = a[i]; let j = i;
      while (j > 0 && key(a[j - 1]) > key(m)) { a[j] = a[j - 1]; j--; }
      a[j] = m;
    }
    return a;
  }
  // Exp 9 — quick sort (Lomuto partition, pivot = last element)
  function quickSort(arr, key) {
    const a = arr.slice();
    const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
    const partition = (low, high) => {
      const pivot = key(a[high]); let i = low - 1;
      for (let j = low; j <= high - 1; j++) if (key(a[j]) <= pivot) swap(++i, j);
      swap(i + 1, high);
      return i + 1;
    };
    const qs = (low, high) => { if (low < high) { const pi = partition(low, high); qs(low, pi - 1); qs(pi + 1, high); } };
    qs(0, a.length - 1);
    return a;
  }
  // Exp 10 — merge sort (merge two sorted runs into C)
  function mergeSort(arr, key) {
    if (arr.length < 2) return arr.slice();
    const mid = arr.length >> 1;
    const A = mergeSort(arr.slice(0, mid), key), B = mergeSort(arr.slice(mid), key);
    const C = []; let p = 0, q = 0;
    while (p < A.length && q < B.length) C.push(key(A[p]) <= key(B[q]) ? A[p++] : B[q++]);
    while (p < A.length) C.push(A[p++]);
    while (q < B.length) C.push(B[q++]);
    return C;
  }
  // Exp 12 — heap sort with max_heapify
  function heapSort(arr, key) {
    const a = arr.slice(), n = a.length;
    const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
    const maxHeapify = (i, size) => {
      const l = 2 * i + 1, r = 2 * i + 2; let largest = i;
      if (l < size && key(a[l]) > key(a[largest])) largest = l;
      if (r < size && key(a[r]) > key(a[largest])) largest = r;
      if (largest !== i) { swap(i, largest); maxHeapify(largest, size); }
    };
    for (let i = (n >> 1) - 1; i >= 0; i--) maxHeapify(i, n);
    for (let i = n - 1; i > 0; i--) { swap(0, i); maxHeapify(0, i); }
    return a;
  }

  /* ---------------------------------------------------------------------
   * Experiment 11 — binary search tree (insert, inorder)
   * Stores the hashtag bank; prefix lookups prune whole subtrees.
   * ------------------------------------------------------------------- */
  class BST {
    constructor() { this.root = null; this.count = 0; }
    insert(key, weight = 1) {
      key = key.toLowerCase();
      const node = { key, weight, left: null, right: null };
      if (!this.root) { this.root = node; this.count++; return; }
      let p = this.root;
      for (;;) {
        if (key === p.key) { p.weight += weight; return; }
        const dir = key < p.key ? 'left' : 'right';
        if (!p[dir]) { p[dir] = node; this.count++; return; }
        p = p[dir];
      }
    }
    inorder(node = this.root, out = []) {
      if (node) { this.inorder(node.left, out); out.push(node); this.inorder(node.right, out); }
      return out;
    }
    // all keys starting with `prefix`, in sorted order
    prefix(prefix, node = this.root, out = []) {
      if (!node) return out;
      prefix = prefix.toLowerCase();
      const head = node.key.slice(0, prefix.length);
      if (prefix <= head) this.prefix(prefix, node.left, out);
      if (node.key.startsWith(prefix)) out.push(node);
      if (prefix >= head) this.prefix(prefix, node.right, out);
      return out;
    }
  }

  /* ---------------------------------------------------------------------
   * Experiments 13.1 / 13.2 — BFS and DFS over an adjacency matrix.
   * Auto-reel builds a graph where scenes are vertices and an edge joins two
   * scenes that "go well together" (same kind, similar name or prompt words).
   * BFS gives a gentle story order; DFS gives a "deep dive" order.
   * ------------------------------------------------------------------- */
  function buildSceneGraph(items) {
    const n = items.length;
    const a = Array.from({ length: n }, () => new Array(n).fill(0));
    const words = items.map((it) => new Set((it.name + ' ' + (it.prompt || '')).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)));
    for (let x = 0; x < n; x++) {
      for (let y = x + 1; y < n; y++) {
        let shared = 0; words[x].forEach((w) => { if (words[y].has(w)) shared++; });
        if (shared > 0 || items[x].kind === items[y].kind) { a[x][y] = 1; a[y][x] = 1; }
      }
    }
    return a;
  }
  function bfs(a, v = 0) {
    const n = a.length, visited = new Array(n).fill(0), order = [];
    const qu = new Queue();
    for (let s = 0; s < n; s++) {
      const start = s === 0 ? v : s;
      if (visited[start]) continue;
      visited[start] = 1; qu.enqueue(start);
      while (!qu.isEmpty()) {
        const x = qu.dequeue(); order.push(x);
        for (let j = 0; j < n; j++) if (a[x][j] && !visited[j]) { visited[j] = 1; qu.enqueue(j); }
      }
    }
    return order;
  }
  function dfs(a, v = 0) {
    const n = a.length, visited = new Array(n).fill(0), order = [];
    const stk = new Stack(n * n + n);
    for (let s = 0; s < n; s++) {
      const start = s === 0 ? v : s;
      if (visited[start]) continue;
      stk.push(start);
      while (!stk.isEmpty()) {
        const x = stk.pop();
        if (visited[x]) continue;
        visited[x] = 1; order.push(x);
        for (let j = n - 1; j >= 0; j--) if (a[x][j] && !visited[j]) stk.push(j);
      }
    }
    return order;
  }

  global.DS = {
    MediaLibrary, binarySearchStart, Timeline, Stack, History,
    infixToPostfix, evalPostfix, evaluate, Queue,
    insertionSort, quickSort, mergeSort, heapSort, BST,
    buildSceneGraph, bfs, dfs,
  };
})(typeof window !== 'undefined' ? window : globalThis);
