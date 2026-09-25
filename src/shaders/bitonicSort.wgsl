struct SortParams {
  n: u32,
  valid: u32,
  stage: u32,
  stride: u32,
}

@group(0) @binding(0) var<storage, read_write> indices: array<u32>;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<uniform> sortParams: SortParams;

const SENTINEL: u32 = 0xffffffffu;

fn keyOf(id: u32) -> u32 {
  if (id == SENTINEL) {
    return SENTINEL;
  }
  return keys[id];
}

@compute @workgroup_size(256)
fn fillIndices(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let n = sortParams.n;
  let valid = sortParams.valid;
  if (i >= n) {
    return;
  }
  indices[i] = select(SENTINEL, i, i < valid);
}

@compute @workgroup_size(256)
fn bitonicPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let n = sortParams.n;
  let stride = sortParams.stride;
  let k = sortParams.stage;
  if (i >= n) {
    return;
  }
  let ixj = i ^ stride;
  if (ixj <= i) {
    return;
  }
  let keyA = keyOf(indices[i]);
  let keyB = keyOf(indices[ixj]);
  let ascending = (i & k) == 0u;
  let shouldSwap = select((keyA < keyB), (keyA > keyB), ascending);
  if (shouldSwap) {
    let tmp = indices[i];
    indices[i] = indices[ixj];
    indices[ixj] = tmp;
  }
}
