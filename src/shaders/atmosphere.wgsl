// Bottle climate: two terrain-following horizontal layers.
struct TerrainCell { rock: f32, sand: f32, suspended_sand: f32, avalanche: f32, soil: f32, suspended_soil: f32 };
struct AtmosphereCell {
    // XYZ velocity interpolated from MAC faces, then temperature.
    velocityTemperature: vec4<f32>,
    // Water densities per fixed reference layer depth: vapor, cloud, rain, snow.
    moisture: vec4<f32>,
};
struct WeatherUniforms {
    grid: vec4<f32>, spacingTime: vec4<f32>, initialAir: vec4<f32>, environment: vec4<f32>,
    physics: vec4<f32>, radiation: vec4<f32>,
    hydrology: vec4<f32>, // thermal expansion, air drag, evaporation, surface-air conductance
    convection: vec4<f32>, // stability, relief lift, background mixing, convection response
    initial: vec4<f32>, // nominal map km, initial pattern km, initial contrasts, initial seed
    weather: vec4<f32>, // rain lifetime, cloud phase rate, rain evaporation rate, cloud shading
    windBrush: vec4<f32>, // UV origin and radius
    windForce: vec4<f32>, // horizontal acceleration from the cursor
    dynamics: vec4<f32>, // viscosity, maximum timestep, reserved, maximum outgoing Courant
};
@group(0) @binding(0) var<uniform> u: WeatherUniforms;
@group(0) @binding(1) var<storage, read> volumeIn: array<AtmosphereCell>;
@group(0) @binding(2) var<storage, read_write> volumeOut: array<AtmosphereCell>;
// Mean height, pending vapor sensible heat, pending vapor mass, bucket area ratio.
@group(0) @binding(3) var<storage, read_write> columns: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> terrain: array<TerrainCell>;
@group(0) @binding(5) var<storage, read_write> fluids: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> surface: array<vec4<f32>>;
// Deposited rain, snow, sensible heat, padding; all per surface reference depth.
@group(0) @binding(10) var<storage, read_write> precipitation: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> depositionWeights: array<f32>;
@group(0) @binding(16) var<storage, read_write> surfaceHeat: array<f32>;
@group(0) @binding(18) var<storage, read_write> radiationBudget: array<vec4<f32>>;
@group(0) @binding(19) var<storage, read_write> heatProfiles: array<vec4<f32>>;
@group(0) @binding(20) var<storage, read_write> heatTransfers: array<vec4<f32>>;
@group(0) @binding(21) var<storage, read_write> weatherMap: array<vec4<f32>>;
@group(0) @binding(22) var<storage, read_write> longwaveHeating: array<f32>;
@group(0) @binding(25) var<storage, read_write> energyFlux: vec4<f32>;

fn bounded(p: vec3<i32>) -> vec3<i32> {
    let n = vec3<i32>(u.grid.xyz);
    return clamp(p, vec3<i32>(0), n - 1);
}
fn index(p: vec3<i32>) -> u32 {
    let q = bounded(p);
    return u32(q.x + i32(u.grid.x) * (q.y + i32(u.grid.y) * q.z));
}
fn columnIndex(p: vec3<i32>) -> u32 { return index(vec3<i32>(p.xy, 0)); }
fn inside(p: vec3<u32>) -> bool { return all(p < vec3<u32>(u.grid.xyz)); }
fn ambientTemperature(height: f32) -> f32 { return u.initialAir.x - u.physics.x * height; }
fn saturation(t: f32) -> f32 { return cloudSaturation(t); }

struct SurfaceMapping {
    columns: vec4<u32>, // 00, 10, 01, 11, in the original accumulation order.
    fraction: vec2<f32>,
};

fn surfaceMapping(xy: vec2<u32>) -> SurfaceMapping {
    let start = 1u + u32(u.grid.x) * u32(u.grid.y);
    let x = radiationBudget[start + 2u * xy.x];
    let y = radiationBudget[start + 2u * xy.y + 1u];
    let rows = vec2<u32>(y.xy) * u32(u.grid.x);
    let columns = vec2<u32>(x.xy);
    return SurfaceMapping(vec4<u32>(columns.x + rows.x, columns.y + rows.x,
        columns.x + rows.y, columns.y + rows.y), vec2<f32>(x.z, y.z));
}

// Compute the original GPU expressions, including f32 rounding, once for each
// coordinate. The table depends only on grid dimensions; all walls are sealed.
@compute @workgroup_size(64)
fn prepareSurfaceMapping(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u32(u.grid.w)) { return; }
    let xy = (vec2<f32>(f32(id.x)) + 0.5) * u.grid.xy / u.grid.w - 0.5;
    let base = vec2<i32>(floor(xy));
    let fraction = fract(xy);
    let lower = bounded(vec3<i32>(base, 0)).xy;
    let upper = bounded(vec3<i32>(base + vec2<i32>(1), 0)).xy;
    let start = 1u + u32(u.grid.x) * u32(u.grid.y) + 2u * id.x;
    radiationBudget[start] = vec4<f32>(f32(lower.x), f32(upper.x), fraction.x, 0.0);
    radiationBudget[start + 1u] = vec4<f32>(f32(lower.y), f32(upper.y), fraction.y, 0.0);
}

@compute @workgroup_size(16, 16)
fn initializeSurface(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = u32(u.grid.w);
    if (id.x >= n || id.y >= n) { return; }
    let i = id.y * n + id.x;
    let height = (terrain[i].rock + terrain[i].soil + terrain[i].sand) * u.environment.y;
    surface[i] = vec4<f32>(0.0, 0.0, ambientTemperature(height), 0.0);
    heatTransfers[i] = vec4<f32>(0.0);
}

// Exact integer buckets match the fine-to-coarse lookup in surfaceExchange.
// Every fine surface cell is reduced once. No CPU readback and no float atomics.
@compute @workgroup_size(8, 8)
fn reduceColumns(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = vec2<u32>(u.grid.xy);
    if (any(id.xy >= n)) { return; }
    let fine = u32(u.grid.w);
    let start = (id.xy * fine + n - vec2<u32>(1)) / n;
    let end = ((id.xy + vec2<u32>(1)) * fine + n - vec2<u32>(1)) / n;
    var totals = vec2<f32>(0.0);
    var heightSum = 0.0;
    var count = 0.0;
    for (var y = start.y; y < end.y; y++) {
        for (var x = start.x; x < end.x; x++) {
            let i = y * fine + x;
            let cover = surface[i];
            let height = max(0.0, terrain[i].rock + terrain[i].soil + terrain[i].sand + max(fluids[i].x, 0.0) + max(fluids[i].y, 0.0) + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
            heightSum += height;
            // surfaceExchange reused this scratch after the previous gather.
            // Copy the pending vapor heat before exchangeHeat overwrites it.
            totals += vec2<f32>(heatTransfers[i].w, max(cover.w, 0.0));
            count += 1.0;
        }
    }
    // Exact area accounting also covers non-divisible test grids.
    let areaRatio = max(count * f32(n.x * n.y) / f32(fine * fine), 0.000001);
    columns[id.y * n.x + id.x] = vec4<f32>(heightSum / max(count, 1.0), totals / max(count, 1.0), areaRatio);
}


// Initial heterogeneity only. No traveling pattern or external thermostat.
fn initialPattern(uv: vec2<f32>) -> f32 {
    let k = max(1.0, round(u.initial.x / (2.0 * u.initial.y)));
    let phase = u.initial.w * 2.399963;
    let p = uv * 6.2831853;
    return 0.55 * sin(p.x * k + p.y + phase) + 0.30 * cos(p.y * k - p.x + phase * 1.7)
        + 0.15 * sin(p.x * (k + 1.0) + p.y * (k - 1.0) + phase * 0.7);
}
@compute @workgroup_size(8, 8)
fn initializeVolume(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let ci = id.y * u32(u.grid.x) + id.x;
    let pattern = initialPattern((vec2<f32>(id.xy) + 0.5) / u.grid.xy) * u.initial.z;
    let upper = f32(id.z);
    let temperature = ambientTemperature(columns[ci].x) - pattern * 4.0 - upper * (u.physics.x*u.spacingTime.z - u.convection.x*8.0);
    let rh = max(0.0, u.initialAir.y * (1.0 + pattern * 0.8));
    let p = vec2<i32>(id.xy);
    let east = select(initialFace(p,0u),0.0,id.z==1u);
    let north = select(initialFace(p,1u),0.0,id.z==1u);
    volumeOut[index(vec3<i32>(id))] = AtmosphereCell(vec4<f32>(0.0,0.0,0.0,temperature),
        vec4<f32>(saturation(temperature)*rh,0.0,0.0,0.0));
    circulationFaces[index(vec3<i32>(id))] = vec4<f32>(east,north,0.0,0.0);
    if (id.z == 0u) {
        weatherMap[ci] = vec4<f32>(0.0);
    }
}

fn adjustCloudPhase(cell: AtmosphereCell, dt: f32) -> AtmosphereCell {
    var c=cell;
    let transfer=cloudPhaseTransfer(c.velocityTemperature.w,c.moisture.x,c.moisture.y)*(1.0-exp(-u.weather.y*dt));
    c.moisture.x-=transfer; c.moisture.y+=transfer; c.velocityTemperature.w+=transfer*cloudLatentHeat;
    return c;
}

fn evaporateRain(cell: AtmosphereCell, dt: f32) -> AtmosphereCell {
    var c=cell;
    // The saturation solve includes evaporative cooling. Rain cannot borrow
    // water from outside or continue cooling air that has reached saturation.
    let evaporated=max(0.0,-cloudPhaseTransfer(c.velocityTemperature.w,c.moisture.x,c.moisture.z))
        *(1.0-exp(-u.weather.z*dt));
    c.moisture.z-=evaporated; c.moisture.x+=evaporated; c.velocityTemperature.w-=evaporated*cloudLatentHeat;
    return c;
}

fn formPrecipitation(cell: AtmosphereCell, rainEfficiency: f32) -> AtmosphereCell {
    var c=cell;
    let cloud=max(c.moisture.y,0.0);
    // Shallow fog is a poor rain producer. Most rain matures in the upper layer,
    // giving newly evaporated water time to leave its source before falling.
    let growth=rainEfficiency*(0.3+1.7*cloud/(cloud+0.003))/u.weather.x;
    let formed=cloud*(1.0-exp(-growth*u.spacingTime.w));
    let snowFraction=1.0-smoothstep(-1.5,0.0,c.velocityTemperature.w);
    // Cloud droplets are liquid, including supercooled droplets. Freezing into
    // snow releases fusion heat, with enough cold capacity to stay at/below 0 C.
    let frozen=min(formed*snowFraction,max(-c.velocityTemperature.w,0.0)/cloudFusionHeat);
    c.moisture.y-=formed; c.moisture.z+=formed-frozen; c.moisture.w+=frozen;
    c.velocityTemperature.w+=frozen*cloudFusionHeat;
    return c;
}
@compute @workgroup_size(8, 8)
fn microphysics(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u.grid.xy))) { return; }
    let ci=id.y*u32(u.grid.x)+id.x; let hi=ci+u32(u.grid.x*u.grid.y); let dt=u.spacingTime.w;
    var low=volumeOut[ci]; var high=volumeOut[hi];
    let p=vec3<i32>(vec2<i32>(id.xy),0);
    let slope=vec2<f32>(columns[columnIndex(p+vec3<i32>(1,0,0))].x-columns[columnIndex(p-vec3<i32>(1,0,0))].x,
        columns[columnIndex(p+vec3<i32>(0,1,0))].x-columns[columnIndex(p-vec3<i32>(0,1,0))].x)/(2.0*u.spacingTime.xy);
    let lift=max(dot(low.velocityTemperature.xy,slope),0.0)*u.convection.y;
    let instability=max(low.velocityTemperature.w-high.velocityTemperature.w-u.physics.x*u.spacingTime.z,0.0);
    let mixing=max(0.0,u.convection.z)+min(0.12,instability*0.004*u.convection.w+lift*0.025);
    let fraction=min(0.25,1.0-exp(-mixing*dt));
    let exchange=(low.moisture-high.moisture)*fraction;
    low.moisture-=exchange; high.moisture+=exchange;
    // Background mixing exchanges sensible heat; isothermal resting air must
    // remain isothermal. Only unstable overturning uses the dry lapse offset.
    let background=1.0-exp(-max(u.convection.z,0.0)*dt);
    let overturning=1.0-exp(-max(mixing-u.convection.z,0.0)*dt);
    let heat=(low.velocityTemperature.w-high.velocityTemperature.w)*background
        + instability*overturning;
    low.velocityTemperature.w-=heat; high.velocityTemperature.w+=heat;
    // The other half of cloud adjustment follows transport and layer mixing.
    low=formPrecipitation(adjustCloudPhase(low,dt*0.5),0.2);
    high=formPrecipitation(adjustCloudPhase(high,dt*0.5),1.0);
    high=evaporateRain(high,dt*0.5);
    let upperFall=high.moisture.zw*(vec2<f32>(1.0)-exp(-dt/vec2<f32>(u.physics.y,u.physics.z)));
    high.moisture.z-=upperFall.x; high.moisture.w-=upperFall.y;
    low.moisture.z+=upperFall.x; low.moisture.w+=upperFall.y;
    // Snow falling through warm lower air melts with a paired latent heat debit.
    let melted=min(low.moisture.w,max(low.velocityTemperature.w,0.0)/cloudFusionHeat*(1.0-exp(-dt*0.2)));
    low.moisture.w-=melted; low.moisture.z+=melted; low.velocityTemperature.w-=melted*cloudFusionHeat;
    // Newly arriving rain (and meltwater) encounters lower-air dryness BEFORE
    // ground deposition. The resulting cold pool drives ordinary thermal
    // outflow on the next circulation step; there is no added gust force.
    low=evaporateRain(low,dt*0.5);
    let fallen=low.moisture.zw*(vec2<f32>(1.0)-exp(-dt/vec2<f32>(u.physics.y,u.physics.z)));
    low.moisture.z-=fallen.x; low.moisture.w-=fallen.y;
    // Debit the exact heat delivered with precipitation, then deposit the same
    // weighted quantity. Reconstructing it from receiver temperatures would
    // create/destroy heat at grid transitions and temperature gradients.
    let fallenHeat=fallen.x*8.0*low.velocityTemperature.w
        +fallen.y*2.0*min(low.velocityTemperature.w,0.0);
    low.velocityTemperature.w-=fallenHeat;
    precipitation[ci]=vec4<f32>(fallen,fallenHeat,0.0)*u.spacingTime.z/u.environment.y;
    let rainRate=(fallen.x+fallen.y)*u.spacingTime.z/u.environment.y/max(dt,0.000001);
    // Wetness is a diagnostic memory of rainfall, never an extra water source.
    var wet=weatherMap[ci].x*exp(-dt/180.0);
    wet=1.0-(1.0-wet)*exp(-rainRate*dt*700.0);
    let cover=1.0-cloudSunTransmission(low.moisture.y+high.moisture.y,1.0);
    weatherMap[ci]=vec4<f32>(wet,rainRate,interfaceVelocity(vec2<i32>(id.xy)),cover);
    volumeOut[ci]=low; volumeOut[hi]=high;
}
// Vapor, deposited rain, deposited snow, deposited sensible heat.
fn surfaceWeather(mapping: SurfaceMapping) -> vec4<f32> {
    let f=mapping.fraction; var result=vec4<f32>(0.0);
    for (var y=0;y<2;y++) { for(var x=0;x<2;x++) {
        let ci=mapping.columns[y*2+x]; let w=select(1.0-f,f,vec2<bool>(x==1,y==1)); let weight=w.x*w.y;
        let cell=volumeIn[ci];
        result+=vec4<f32>(cell.moisture.x,precipitation[ci].xyz*depositionWeights[ci])*weight;
    }}
    return result;
}
fn surfaceTransmission(mapping: SurfaceMapping) -> f32 {
    let f=mapping.fraction; var cloud=0.0; let n=u32(u.grid.x*u.grid.y);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){
        let ci=mapping.columns[y*2+x]; let w=select(1.0-f,f,vec2<bool>(x==1,y==1));
        cloud+=(volumeIn[ci].moisture.y+volumeIn[ci+n].moisture.y)*w.x*w.y;
    }}
    return cloudSunTransmission(cloud,u.weather.w);
}
fn terrainElevation(p: vec2<i32>) -> f32 {
    let n = i32(u.grid.w);
    let q = clamp(p, vec2<i32>(0), vec2<i32>(n - 1));
    let cell = terrain[u32(q.y * n + q.x)];
    return (cell.rock + cell.soil + cell.sand) * u.environment.y;
}

fn surfaceHeatCapacity(i: u32, liquid: f32, ice: f32, snow: f32) -> f32 {
    return materialHeatCapacity(terrain[i].sand, terrain[i].soil, liquid, ice, snow);
}

// Local sunlight absorption only. Material albedo changes the absorbed flux;
// heat capacity changes the resulting temperature, without redistributing solar
// energy from other cells to exaggerate land-water contrasts.
fn solarAbsorption(pos: vec2<i32>) -> f32 {
    let i = u32(pos.y)*u32(u.grid.w)+u32(pos.x);
    let cover = surface[i]; let liquid = max(fluids[i].x,0.0);
    let albedo = materialAlbedo(terrain[i].sand,terrain[i].soil,liquid,cover.y,cover.x);
    let normal = normalize(vec3<f32>(
        terrainElevation(pos-vec2<i32>(1,0))-terrainElevation(pos+vec2<i32>(1,0)),
        terrainElevation(pos-vec2<i32>(0,1))-terrainElevation(pos+vec2<i32>(0,1)),400.0/u.grid.w));
    return (1.0-albedo)*max(0.0,dot(normal,u.radiation.xyz))*0.65;
}

var<workgroup> solarSum: array<vec2<f32>, 256>;

fn sumSolar(lane: u32) {
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride /= 2u) {
        if (lane < stride) { solarSum[lane] += solarSum[lane + stride]; }
        workgroupBarrier();
    }
}

// Temperatures are defined at the mean surface of each terrain-following column.
@compute @workgroup_size(8, 8)
fn prepareHeat(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u.grid.xy))) { return; }
    let ci = id.y * u32(u.grid.x) + id.x;
    let cell = volumeIn[ci];
    let capacity = u.spacingTime.z * depositionWeights[ci] / max(u.environment.y, 0.001);
    heatProfiles[ci] = vec4<f32>(cell.velocityTemperature.w + u.physics.x * columns[ci].x,
        -u.physics.x, length(cell.velocityTemperature.xy), 1.0 / capacity);
}

// Each fine cell exchanges with four air columns. Weight pairwise relaxation,
// rather than the timestep, so both surface and air updates remain bounded by
// their capacities when all neighbors contribute. Store the exact signed debits
// for the subsequent gather: no float atomics or concurrent surface writes.
@compute @workgroup_size(16, 16)
fn exchangeHeat(@builtin(global_invocation_id) id: vec3<u32>) {
    let fine = u32(u.grid.w);
    if (any(id.xy >= vec2<u32>(fine))) { return; }
    let i = id.y * fine + id.x;
    let cover = surface[i];
    let liquid = max(fluids[i].x, 0.0);
    let height = max(0.0, terrain[i].rock + terrain[i].soil + terrain[i].sand + liquid + max(fluids[i].y, 0.0)
        + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
    let capacity = surfaceHeatCapacity(i, liquid, cover.y, cover.x);
    let insulation = 1.0 + cover.x * 5.0 * u.environment.y * 5.0;
    let mapping = surfaceMapping(id.xy);
    let f = mapping.fraction;
    var transfers = vec4<f32>(0.0);
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let profile = heatProfiles[mapping.columns[y * 2 + x]];
            if (profile.w <= 0.0) { continue; }
            let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
            let difference = cover.z - (profile.x + profile.y * height);
            let mixing = 1.0 + min(2.0, profile.z * 0.12 + sqrt(max(difference, 0.0)) * 0.15);
            let conductance = max(u.hydrology.w,0.0) * mixing / insulation;
            let inverseCapacity = 1.0 / capacity + profile.w;
            transfers[y * 2 + x] = weight.x * weight.y * difference
                * (1.0 - exp(-conductance * inverseCapacity * u.spacingTime.w)) / inverseCapacity;
        }
    }
    heatTransfers[i] = transfers;
    surface[i].z = cover.z - dot(transfers, vec4<f32>(1.0)) / capacity;
}

fn longwaveEmission(temperature: f32) -> f32 {
    let kelvin = max(temperature + 273.15, 150.0);
    return u.radiation.w * 0.25 * pow(kelvin / 288.15, 4.0);
}

var<workgroup> gatheredHeat: array<vec2<f32>, 64>;

// One workgroup gathers a column's overlapping tent footprint. Read each stored
// debit exactly once for its recipient, including both clamped neighbors at a
// wall. Convert fine-cell surface energy
// to the receiving air cell's temperature using physical areas, not bucket sizes.
@compute @workgroup_size(64)
fn gatherHeat(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let n = vec2<u32>(u.grid.xy);
    if (any(id.xy >= n)) { return; }
    let fine = i32(u.grid.w);
    let ci = id.y * n.x + id.x;
    var start = vec2<i32>(ceil((vec2<f32>(id.xy) - 0.5) * u.grid.w / u.grid.xy - 0.5));
    var end = vec2<i32>(ceil((vec2<f32>(id.xy) + 1.5) * u.grid.w / u.grid.xy - 0.5));
    start = max(start, vec2<i32>(0));
    end = min(end, vec2<i32>(fine));
    let extent = end - start;
    var heat = vec2<f32>(0.0);
    for (var k = i32(lane); k < extent.x * extent.y; k += 64) {
        let q = start + vec2<i32>(k % extent.x, k / extent.x);
        let mapping = surfaceMapping(vec2<u32>(q));
        let transfers = heatTransfers[q.y * fine + q.x];
        let emission = longwaveEmission(surface[q.y * fine + q.x].z);
        let f = mapping.fraction;
        for (var y = 0; y < 2; y++) {
            for (var x = 0; x < 2; x++) {
                if (mapping.columns[y * 2 + x] == ci) {
                    let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
                    heat += vec2<f32>(transfers[y * 2 + x], emission * weight.x * weight.y);
                }
            }
        }
    }
    gatheredHeat[lane] = heat;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride /= 2u) {
        if (lane < stride) { gatheredHeat[lane] += gatheredHeat[lane + stride]; }
        workgroupBarrier();
    }
    if (lane == 0u) {
        let areaRatio = u.grid.x * u.grid.y / (u.grid.w * u.grid.w);
        surfaceHeat[ci] = gatheredHeat[0].x * areaRatio
            * max(u.environment.y, 0.001) / u.spacingTime.z;
        radiationBudget[ci + 1u] = vec4<f32>(gatheredHeat[0].y * areaRatio * depositionWeights[ci], 0.0, 0.0, 0.0);
    }
}

fn airEmissivity(cell: AtmosphereCell) -> f32 {
    // Gray-gas optical depth at the illustrative domain scale. Even dry air
    // radiates; vapor and condensed water increase absorption and emission.
    let opacity = 1.2 + 50.0 * min(cell.moisture.x, 0.06)
        + 250.0 * min(cell.moisture.y + cell.moisture.z + cell.moisture.w, 0.03);
    return 1.0 - exp(-opacity * u.spacingTime.z / u.environment.w);
}

// Two-stream infrared transfer, independent of air motion and solar input.
// The mechanical lid is transparent to radiation: no incoming IR from space.
// Each layer absorbs incoming flux and emits in both directions. Flux differences
// telescope, so surface + air lose exactly the energy escaping at the top.
@compute @workgroup_size(8, 8)
fn radiateColumns(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u.grid.xy))) { return; }
    let ci = id.y * u32(u.grid.x) + id.x;
    let capacity = u.spacingTime.z * depositionWeights[ci] / max(u.environment.y, 0.001);
    let toTemperature = u.spacingTime.w / capacity;
    var downward = 0.0;
    for (var z = i32(u.grid.z) - 1; z >= 0; z--) {
        let p = vec3<i32>(vec2<i32>(id.xy), z);
        let i = index(p);
        longwaveHeating[i] = 0.0;
        if (u.radiation.w <= 0.0) { continue; }
        let cell = volumeIn[i];
        let absorbed = airEmissivity(cell) * (downward - longwaveEmission(cell.velocityTemperature.w));
        downward -= absorbed;
        longwaveHeating[i] = absorbed * toTemperature;
    }
    radiationBudget[ci + 1u].y = downward;
    var upward = radiationBudget[ci + 1u].x;
    for (var z = 0; z < i32(u.grid.z); z++) {
        let p = vec3<i32>(vec2<i32>(id.xy), z);
        if (u.radiation.w <= 0.0) { continue; }
        let i = index(p);
        let cell = volumeIn[i];
        let absorbed = airEmissivity(cell) * (upward - longwaveEmission(cell.velocityTemperature.w));
        upward -= absorbed;
        longwaveHeating[i] += absorbed * toTemperature;
    }
    radiationBudget[ci + 1u].z = upward;
}

fn surfaceLongwave(mapping: SurfaceMapping) -> vec2<f32> {
    let f = mapping.fraction;
    var flux = vec2<f32>(0.0);
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
            flux += weight.x * weight.y * radiationBudget[mapping.columns[y * 2 + x] + 1u].yz;
        }
    }
    return flux;
}

// Each invocation owns exactly one fine cell. No neighboring fluids are read
// or written, so the existing fluid buffer can safely be updated in place.
@compute @workgroup_size(16, 16)
fn surfaceExchange(@builtin(global_invocation_id) id: vec3<u32>,
    @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let n = u32(u.grid.w);
    var externalFlux = vec2<f32>(0.0);
    // Every lane participates in the reduction, including partial edge tiles.
    if (id.x < n && id.y < n) {
        let i = id.y * n + id.x;
        let dt = u.spacingTime.w;
        // Use local cover before precipitation and phase changes alter it.
        let mapping = surfaceMapping(id.xy);
        let absorbedSolar = u.environment.x * solarAbsorption(vec2<i32>(id.xy)) * surfaceTransmission(mapping);
        var cover = surface[i];
        var liquid = fluids[i];
        // Use the same pre-phase surface emission gathered for the air budget.
        let longwave = surfaceLongwave(mapping);
        let netLongwave = longwave.x - longwaveEmission(cover.z);
        externalFlux = vec2<f32>(absorbedSolar, longwave.y);
        let weather = surfaceWeather(mapping);
        let vapor = weather.x;
        let fallen = weather.yz;
        liquid.x = max(liquid.x, 0.0);
        cover.x = max(cover.x, 0.0);
        cover.y = max(cover.y, 0.0);
        let latentFusion = cloudFusionHeat;
        var energy = cover.z * surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
        liquid.x += fallen.x;
        cover.x += fallen.y;
        energy += weather.w;
        // Resolve only the submerged snow. Traces of rain/meltwater cannot erase
        // a whole cell's cover, and cold submerged snow compacts into bottom ice
        // instead of melting without an available heat source.
        if (liquid.x > 0.0 && cover.x > 0.0) {
            let transfer = wetSnowTransfer(liquid.x, cover.x, energy);
            energy -= transfer.x * latentFusion;
            liquid.x += transfer.x;
            cover.x -= transfer.x + transfer.y;
            cover.y += transfer.y;
        }
        cover.z = energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
        // Sensible heat was exchanged conservatively before atmospheric transport.
        energy += (absorbedSolar + netLongwave) * dt;
        // Continuous heat-limited phase transfer: consume only the sensible energy
        // available relative to 0 C, and approach equilibrium over several seconds.
        // Recompute capacity after transfer; latent heat cannot overshoot 0 C.
        if (energy < 0.0) {
            let frozenWater = min(liquid.x, -energy / latentFusion * (1.0 - exp(-0.18 * dt)));
            liquid.x -= frozenWater;
            cover.y += frozenWater;
            energy += frozenWater * latentFusion;
        } else {
            let meltBudget = energy / latentFusion * (1.0 - exp(-0.25 * dt));
            let snowMelt = min(cover.x, meltBudget);
            let iceMelt = min(cover.y, max(meltBudget - snowMelt, 0.0));
            cover.x -= snowMelt;
            cover.y -= iceMelt;
            liquid.x += snowMelt + iceMelt;
            energy -= (snowMelt + iceMelt) * latentFusion;
        }
        cover.z = energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
        let deficit = max(saturation(cover.z) - vapor, 0.0);
        // Only water actually present is evaporated; dry land cannot create vapor.
        // A finite drying time lets fresh rain collect and enter the existing river
        // solver. At the default rate, an exposed film has a ~3 minute e-fold time.
        // Both the actual stock and the atmospheric saturation deficit limit it.
        let rate = max(u.hydrology.z, 0.0);
        let requested = min(max(liquid.x, 0.0) * (1.0 - exp(-rate * dt / 45.0)), deficit * dt * rate);
        // At the temperature floor, evaporation must stop instead of paying
        // its latent cost with energy restored by the numerical clamp.
        let available = max(0.0, energy + 70.0 * surfaceHeatCapacity(i, liquid.x, cover.y, cover.x));
        let evaporation = min(requested, available / (cloudLatentHeat + 8.0 * 70.0));
        let vaporHeat = evaporation * 8.0 * cover.z;
        liquid.x = max(liquid.x - evaporation, 0.0);
        energy -= evaporation * cloudLatentHeat + vaporHeat;
        cover.z = clamp(energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x), -70.0, 90.0);
        // applyAirHeat consumed the previous pending evaporation this step. Steam
        // from the surface fluid solver joins the same conserved water reservoir.
        cover.w = evaporation + max(liquid.w, 0.0);
        liquid.w = 0.0;
        // The four paired heat transfers have already been gathered. Keep the
        // exact sensible debit beside pending vapor until next reduceColumns,
        // reusing scratch memory rather than allocating another fine-grid field.
        heatTransfers[i] = vec4<f32>(0.0,0.0,0.0,vaporHeat);
        surface[i] = cover;
        fluids[i] = liquid;
    }
    solarSum[lane] = externalFlux;
    sumSolar(lane);
    if (lane == 0u) {
        let start = 1u + u32(u.grid.x*u.grid.y) + 2u*n;
        radiationBudget[start + group.y*((n+15u)/16u) + group.x] = vec4<f32>(solarSum[0],0.0,0.0);
    }
}

// The panel uses the EXACT applied solar flux and escaping infrared flux,
// reduced on the GPU. Surface emission absorbed by air is an internal transfer.
@compute @workgroup_size(256)
fn reduceEnergy(@builtin(local_invocation_index) lane: u32) {
    let n = u32(u.grid.w);
    let count = ((n+15u)/16u)*((n+15u)/16u);
    let start = 1u + u32(u.grid.x*u.grid.y) + 2u*n;
    var total = vec2<f32>(0.0);
    for (var i=lane; i<count; i+=256u) { total += radiationBudget[start+i].xy; }
    solarSum[lane] = total;
    sumSolar(lane);
    if (lane == 0u) {
        let rate = solarSum[0]*(200.0/u.grid.w)*(200.0/u.grid.w)*u.environment.y;
        energyFlux = vec4<f32>(rate,rate.x-rate.y,u.environment.z+u.spacingTime.w);
    }
}
