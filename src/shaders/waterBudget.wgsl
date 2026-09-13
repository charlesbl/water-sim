struct BudgetUniforms { surface_size:u32, unused:u32, partial_count:u32, padding:u32, cell_volumes:vec4<f32> };
@group(0) @binding(0) var<uniform> u:BudgetUniforms;
@group(0) @binding(1) var<storage,read> fluids:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> surface:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> exchange:vec4<f32>;
@group(0) @binding(4) var<storage,read_write> partials:array<vec4<f32>>;
@group(0) @binding(5) var<storage,read_write> totals:vec4<f32>;
var<workgroup> values:array<vec4<f32>,256>;
fn reduce(lane:u32){for(var stride=128u;stride>0u;stride/=2u){workgroupBarrier();if(lane<stride){values[lane]+=values[lane+stride];}}workgroupBarrier();}
@compute @workgroup_size(256) fn reduce_cells(@builtin(global_invocation_id) id:vec3<u32>,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>){
 var sum=vec4<f32>(0);if(id.x<u.surface_size*u.surface_size){sum=vec4<f32>(fluids[id.x].x,surface[id.x].xy,0)*u.cell_volumes.x;}
 values[lane]=sum;reduce(lane);if(lane==0u){partials[group.x]=values[0];}
}
@compute @workgroup_size(256) fn reduce_totals(@builtin(local_invocation_index) lane:u32){
 var sum=vec4<f32>(0);var correction=vec4<f32>(0);
 for(var i=lane;i<u.partial_count;i+=256u){let delta=partials[i]-correction;let next=sum+delta;correction=(next-sum)-delta;sum=next;}
 values[lane]=sum;reduce(lane);if(lane==0u){totals=vec4<f32>(values[0].xyz,exchange.x-exchange.y-exchange.z);}
}
