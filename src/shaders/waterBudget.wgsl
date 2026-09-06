struct AirCell {
    velocity_temperature: vec4<f32>,
    moisture: vec4<f32>,
};

struct BudgetUniforms {
    surface_size: u32,
    air_count: u32,
    partial_count: u32,
    padding: u32,
    cell_volumes: vec4<f32>, // surface area * heightScale, air cell volume
};

struct WaterTotals {
    surface: vec4<f32>, // liquid, snow SWE, ice SWE, steam SWE
    air: vec4<f32>, // vapor, cloud, rain, airborne snow
    pending: vec4<f32>, // pending surface evaporation SWE, unused xyz
    padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: BudgetUniforms;
@group(0) @binding(1) var<storage, read> fluids: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> surface_weather: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> volume: array<AirCell>;
@group(0) @binding(4) var<storage, read_write> partials: array<WaterTotals>;
@group(0) @binding(5) var<storage, read_write> totals: WaterTotals;

// 12 KiB per workgroup, below WebGPU's 16 KiB baseline limit.
var<workgroup> shared_surface: array<vec4<f32>, 256>;
var<workgroup> shared_air: array<vec4<f32>, 256>;
var<workgroup> shared_pending: array<vec4<f32>, 256>;

fn reduce_workgroup(local_id: u32) {
    for (var stride = 128u; stride > 0u; stride /= 2u) {
        workgroupBarrier();
        if (local_id < stride) {
            shared_surface[local_id] += shared_surface[local_id + stride];
            shared_air[local_id] += shared_air[local_id + stride];
            shared_pending[local_id] += shared_pending[local_id + stride];
        }
    }
    workgroupBarrier();
}

@compute @workgroup_size(256)
fn reduce_cells(
    @builtin(global_invocation_id) global: vec3<u32>,
    @builtin(local_invocation_index) local_id: u32,
    @builtin(workgroup_id) group: vec3<u32>
) {
    let index = global.x;
    var ground_water = vec4<f32>(0.0);
    var air_water = vec4<f32>(0.0);
    var pending_water = vec4<f32>(0.0);
    if (index < uniforms.surface_size * uniforms.surface_size) {
        let fluid = fluids[index];
        let surface = surface_weather[index];
        ground_water = vec4<f32>(fluid.x, surface.x, surface.y, fluid.w) * uniforms.cell_volumes.x;
        pending_water.x = surface.w * uniforms.cell_volumes.x;
    }
    if (index < uniforms.air_count) {
        air_water = volume[index].moisture * uniforms.cell_volumes.y;
    }
    shared_surface[local_id] = ground_water;
    shared_air[local_id] = air_water;
    shared_pending[local_id] = pending_water;
    reduce_workgroup(local_id);
    if (local_id == 0u) {
        partials[group.x] = WaterTotals(shared_surface[0], shared_air[0], shared_pending[0], vec4<f32>(0.0));
    }
}

@compute @workgroup_size(256)
fn reduce_totals(@builtin(local_invocation_index) local_id: u32) {
    var surface_sum = vec4<f32>(0.0);
    var air_sum = vec4<f32>(0.0);
    var pending_sum = vec4<f32>(0.0);
    var surface_correction = vec4<f32>(0.0);
    var air_correction = vec4<f32>(0.0);
    var pending_correction = vec4<f32>(0.0);
    // Compensated strided sums followed by a balanced tree keep the numerical
    // error small even for a 2048² surface with tiny and large reservoirs.
    for (var index = local_id; index < uniforms.partial_count; index += 256u) {
        let item = partials[index];
        let surface_delta = item.surface - surface_correction;
        let next_surface = surface_sum + surface_delta;
        surface_correction = (next_surface - surface_sum) - surface_delta;
        surface_sum = next_surface;
        let air_delta = item.air - air_correction;
        let next_air = air_sum + air_delta;
        air_correction = (next_air - air_sum) - air_delta;
        air_sum = next_air;
        let pending_delta = item.pending - pending_correction;
        let next_pending = pending_sum + pending_delta;
        pending_correction = (next_pending - pending_sum) - pending_delta;
        pending_sum = next_pending;
    }
    shared_surface[local_id] = surface_sum;
    shared_air[local_id] = air_sum;
    shared_pending[local_id] = pending_sum;
    reduce_workgroup(local_id);
    if (local_id == 0u) {
        totals = WaterTotals(shared_surface[0], shared_air[0], shared_pending[0], vec4<f32>(0.0));
    }
}
