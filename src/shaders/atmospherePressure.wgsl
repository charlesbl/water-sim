// Coupled two-layer MAC projection. phi = dt * pressure / reference density.
// Horizontal walls, bottom and lid have zero normal velocity (Neumann phi).
struct PressureGrid {
    size: vec4<u32>, // nx, ny, coarse nx, coarse ny
    metric: vec4<f32>, // 1/dx², 1/dy², 1/H², relaxation
};
@group(0) @binding(0) var<uniform> grid: PressureGrid;
@group(0) @binding(1) var<storage, read> field: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> rhs: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> result: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read> velocity: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> projected: array<vec4<f32>>;

fn address(p: vec2<i32>) -> u32 { return u32(p.x + p.y*i32(grid.size.x)); }
fn valid(p: vec2<i32>) -> bool {
    return all(p >= vec2<i32>(0)) && all(p < vec2<i32>(grid.size.xy));
}
fn neighborSum(p: vec2<i32>) -> vec3<f32> {
    var sum = vec2<f32>(0.0); var diagonal = 0.0;
    for (var axis=0u; axis<2u; axis++) {
        var offset=vec2<i32>(0); offset[axis]=1;
        for (var sign=-1; sign<=1; sign+=2) {
            let q=p+sign*offset;
            if (valid(q)) { sum+=grid.metric[axis]*field[address(q)]; diagonal+=grid.metric[axis]; }
        }
    }
    return vec3<f32>(sum,diagonal);
}

@compute @workgroup_size(8,8)
fn buildRhs(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy>=grid.size.xy)) { return; }
    let i=id.y*grid.size.x+id.x; let count=grid.size.x*grid.size.y;
    var divergence=vec2<f32>(0.0);
    for (var layer=0u; layer<2u; layer++) {
        let j=i+layer*count; let east=velocity[j].x; let north=velocity[j].y;
        var west=0.0; var south=0.0;
        if (id.x>0u) { west=velocity[j-1u].x; }
        if (id.y>0u) { south=velocity[j-grid.size.x].y; }
        divergence[layer]=(east-west)*sqrt(grid.metric.x)+(north-south)*sqrt(grid.metric.y)
            +select(1.0,-1.0,layer==1u)*velocity[i].z*sqrt(grid.metric.z);
    }
    result[i]=-divergence;
}

@compute @workgroup_size(8,8)
fn relaxPressure(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy>=grid.size.xy)) { return; }
    let p=vec2<i32>(id.xy); let i=address(p); let neighbors=neighborSum(p);
    let value=rhs[i]+neighbors.xy; let d=neighbors.z; let k=grid.metric.z;
    // Invert the vertical 2x2 block exactly. On the 1x1 coarsest grid the
    // common pressure is an arbitrary gauge, while the difference is solvable.
    var mean=0.0;
    if (d>0.0) { mean=0.5*(value.x+value.y)/d; }
    let difference=0.5*(value.x-value.y)/(d+2.0*k);
    let correction=vec2<f32>(mean+difference,mean-difference);
    result[i]=mix(field[i],correction,select(grid.metric.w,1.0,d==0.0));
}

@compute @workgroup_size(8,8)
fn residual(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy>=grid.size.xy)) { return; }
    let p=vec2<i32>(id.xy); let i=address(p); let neighbors=neighborSum(p);
    let value=field[i];
    result[i]=rhs[i]-(neighbors.z*value-neighbors.xy+grid.metric.z*(value-value.yx));
}

@compute @workgroup_size(8,8)
fn restrictResidual(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy>=grid.size.zw)) { return; }
    let p=vec2<i32>(id.xy*2u);
    result[id.y*grid.size.z+id.x]=0.25*(field[address(p)]+field[address(p+vec2<i32>(1,0))]
        +field[address(p+vec2<i32>(0,1))]+field[address(p+vec2<i32>(1,1))]);
}

fn coarse(p: vec2<i32>) -> vec2<f32> {
    let q=clamp(p,vec2<i32>(0),vec2<i32>(grid.size.zw)-1);
    return rhs[u32(q.x+q.y*i32(grid.size.z))];
}
@compute @workgroup_size(8,8)
fn prolong(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy>=grid.size.xy)) { return; }
    let p=(vec2<f32>(id.xy)+0.5)*0.5-0.5; let base=vec2<i32>(floor(p)); let f=fract(p);
    let correction=mix(mix(coarse(base),coarse(base+vec2<i32>(1,0)),f.x),
        mix(coarse(base+vec2<i32>(0,1)),coarse(base+vec2<i32>(1,1)),f.x),f.y);
    let i=id.y*grid.size.x+id.x;
    result[i]=field[i]+correction;
}

@compute @workgroup_size(8,8)
fn project(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy>=grid.size.xy) || id.z>=2u) { return; }
    let i=id.y*grid.size.x+id.x; let j=i+id.z*grid.size.x*grid.size.y;
    let pressure=field[i][id.z]; var next=vec4<f32>(0.0);
    if (id.x+1u<grid.size.x) { next.x=velocity[j].x-(field[i+1u][id.z]-pressure)*sqrt(grid.metric.x); }
    if (id.y+1u<grid.size.y) { next.y=velocity[j].y-(field[i+grid.size.x][id.z]-pressure)*sqrt(grid.metric.y); }
    if (id.z==0u) { next.z=velocity[j].z-(field[i].y-pressure)*sqrt(grid.metric.z); }
    projected[j]=next;
}
