struct PermuteParams {
  count: u32,
  floats: u32,
  srcBase: u32,
  _pad: u32,
}

@group(0) @binding(0) var<storage, read> srcInst: array<f32>;
@group(0) @binding(1) var<storage, read> permIndex: array<u32>;
@group(0) @binding(2) var<storage, read_write> dstInst: array<f32>;
@group(0) @binding(3) var<uniform> permParams: PermuteParams;

@compute @workgroup_size(64)
fn permuteInstances(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let count = permParams.count;
  if (i >= count) {
    return;
  }
  let fp = permParams.floats;
  let srcI = permIndex[i];
  if (srcI >= count) {
    return;
  }
  let srcOff = (permParams.srcBase + srcI) * fp;
  let dstOff = i * fp;
  for (var f = 0u; f < fp; f = f + 1u) {
    dstInst[dstOff + f] = srcInst[srcOff + f];
  }
}
