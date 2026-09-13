struct BoundaryUniforms { size:f32, heightScale:f32, unused:vec2<f32> };
@group(0) @binding(0) var<uniform> u:BoundaryUniforms;
@group(0) @binding(1) var<storage,read> flux:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> exchange:vec4<f32>;
var<workgroup> sums:array<f32,256>;
// Sample the exact outgoing boundary flux before fluid transport consumes it.
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) lane:u32){
    let n=u32(u.size);var amount=0.0;
    for(var i=lane;i<n;i+=256u){amount+=flux[i*n].x+flux[i*n+n-1u].y+flux[i].z+flux[(n-1u)*n+i].w;}
    sums[lane]=amount;
    for(var stride=128u;stride>0u;stride/=2u){workgroupBarrier();if(lane<stride){sums[lane]+=sums[lane+stride];}}
    workgroupBarrier();if(lane==0u){exchange.z+=sums[0]*pow(200.0/u.size,2.0)*u.heightScale;}
}
