// Regional game weather: two terrain-following horizontal layers.
struct TerrainCell { rock: f32, sand: f32, suspended_sand: f32, avalanche: f32, soil: f32, suspended_soil: f32 };
struct AtmosphereCell {
    // Horizontal velocity, pressure anomaly, temperature (NOT an XYZ velocity).
    velocityTemperature: vec4<f32>,
    // Water densities per fixed reference layer depth: vapor, cloud, rain, snow.
    moisture: vec4<f32>,
};
struct WeatherUniforms {
    grid: vec4<f32>, spacingTime: vec4<f32>, forcing: vec4<f32>, environment: vec4<f32>,
    physics: vec4<f32>, radiation: vec4<f32>, hydrology: vec4<f32>,
    convection: vec4<f32>, // stability, relief lift, background mixing, convection response
    regional: vec4<f32>, // map km, initial pattern km, variability, seed
    weather: vec4<f32>, // rain lifetime, shear, circulation, cloud shading
    driving: vec4<f32>, // regional energy supply, renewal seconds, rotation, unused
    reserved1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: WeatherUniforms;
@group(0) @binding(1) var<storage, read> volumeIn: array<AtmosphereCell>;
@group(0) @binding(2) var<storage, read_write> volumeOut: array<AtmosphereCell>;
@group(0) @binding(3) var<storage, read_write> columns: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> terrain: array<TerrainCell>;
@group(0) @binding(5) var<storage, read_write> fluids: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> surface: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> precipitation: array<vec2<f32>>;
@group(0) @binding(11) var<storage, read> depositionWeights: array<f32>;
@group(0) @binding(16) var<storage, read_write> surfaceHeat: array<f32>;
@group(0) @binding(17) var<storage, read_write> solarPartials: array<vec2<f32>>;
@group(0) @binding(18) var<storage, read_write> radiationBudget: array<vec4<f32>>;
@group(0) @binding(19) var<storage, read_write> heatProfiles: array<vec4<f32>>;
@group(0) @binding(20) var<storage, read_write> heatTransfers: array<vec4<f32>>;
@group(0) @binding(21) var<storage, read_write> weatherMap: array<vec4<f32>>;
@group(0) @binding(22) var<storage, read_write> longwaveHeating: array<f32>;
@group(0) @binding(24) var<storage, read_write> outgoingCourants: array<f32>;

fn wrap(p: vec3<i32>) -> vec3<i32> {
    let n = vec3<i32>(u.grid.xyz);
    if (u.hydrology.y > 0.5) { return clamp(p, vec3<i32>(0), n - 1); }
    return vec3<i32>(((p.xy % n.xy) + n.xy) % n.xy, clamp(p.z, 0, 1));
}
fn index(p: vec3<i32>) -> u32 {
    let q = wrap(p);
    return u32(q.x + i32(u.grid.x) * (q.y + i32(u.grid.y) * q.z));
}
fn columnIndex(p: vec3<i32>) -> u32 { return index(vec3<i32>(p.xy, 0)); }
fn inside(p: vec3<u32>) -> bool { return all(p < vec3<u32>(u.grid.xyz)); }
fn ambientTemperature(height: f32) -> f32 { return u.forcing.x - u.physics.x * height; }
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
// coordinate. The table depends only on grid dimensions and horizontal borders.
@compute @workgroup_size(64)
fn prepareSurfaceMapping(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u32(u.grid.w)) { return; }
    let xy = (vec2<f32>(f32(id.x)) + 0.5) * u.grid.xy / u.grid.w - 0.5;
    let base = vec2<i32>(floor(xy));
    let fraction = fract(xy);
    let lower = wrap(vec3<i32>(base, 0)).xy;
    let upper = wrap(vec3<i32>(base + vec2<i32>(1), 0)).xy;
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
            totals += vec2<f32>(cover.z, max(cover.w, 0.0));
            count += 1.0;
        }
    }
    // Exact area accounting also covers non-divisible test grids.
    let areaRatio = max(count * f32(n.x * n.y) / f32(fine * fine), 0.000001);
    columns[id.y * n.x + id.x] = vec4<f32>(heightSum / max(count, 1.0), totals / max(count, 1.0), areaRatio);
}


// Smooth periodic air-mass scale. Also shapes the external thermal environment
// when regional drive is enabled; it never writes atmospheric water or rain.
fn initialPattern(uv: vec2<f32>) -> f32 {
    let k = max(1.0, round(u.regional.x / (2.0 * u.regional.y)));
    let phase = u.regional.w * 2.399963;
    let p = uv * 6.2831853;
    return 0.55 * sin(p.x * k + p.y + phase) + 0.30 * cos(p.y * k - p.x + phase * 1.7)
        + 0.15 * sin(p.x * (k + 1.0) + p.y * (k - 1.0) + phase * 0.7);
}
@compute @workgroup_size(8, 8)
fn initializeVolume(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let ci = id.y * u32(u.grid.x) + id.x;
    let pattern = initialPattern((vec2<f32>(id.xy) + 0.5) / u.grid.xy) * u.regional.z;
    let upper = f32(id.z);
    let temperature = ambientTemperature(columns[ci].x) - pattern * 4.0 - upper * (9.0 - u.convection.x * 8.0);
    let rh = max(0.0, u.forcing.y * (1.0 + pattern * 0.8));
    let angle = upper * u.weather.y * 0.8;
    let wind = vec2<f32>(cos(angle) * u.forcing.z - sin(angle) * u.forcing.w,
        sin(angle) * u.forcing.z + cos(angle) * u.forcing.w) * (1.0 + upper * u.weather.y);
    volumeOut[index(vec3<i32>(id))] = AtmosphereCell(vec4<f32>(wind, 0.0, temperature),
        vec4<f32>(saturation(temperature) * rh, 0.0, 0.0, 0.0));
    if (id.z == 0u) { weatherMap[ci] = vec4<f32>(0.0); }
}
fn sampleState(xy: vec2<f32>, z: i32) -> vec4<f32> {
    let base = vec2<i32>(floor(xy)); let f = fract(xy);
    return mix(mix(volumeIn[index(vec3<i32>(base,z))].velocityTemperature,
                   volumeIn[index(vec3<i32>(base+vec2<i32>(1,0),z))].velocityTemperature,f.x),
               mix(volumeIn[index(vec3<i32>(base+vec2<i32>(0,1),z))].velocityTemperature,
                   volumeIn[index(vec3<i32>(base+vec2<i32>(1,1),z))].velocityTemperature,f.x),f.y);
}
fn sampleHeight(xy: vec2<f32>) -> f32 {
    let b = vec2<i32>(floor(xy)); let f = fract(xy);
    return mix(mix(columns[columnIndex(vec3<i32>(b,0))].x, columns[columnIndex(vec3<i32>(b+vec2<i32>(1,0),0))].x,f.x),
               mix(columns[columnIndex(vec3<i32>(b+vec2<i32>(0,1),0))].x, columns[columnIndex(vec3<i32>(b+vec2<i32>(1,1),0))].x,f.x),f.y);
}
fn faceSpeed(p: vec3<i32>, axis: u32) -> f32 {
    var off = vec3<i32>(0); off[axis] = 1;
    if (u.hydrology.y > 0.5 && (p[axis] < 0 || p[axis] >= i32(u.grid[axis])-1)) { return 0.0; }
    return 0.5 * (volumeIn[index(p)].velocityTemperature[axis] + volumeIn[index(p+off)].velocityTemperature[axis]);
}
@compute @workgroup_size(8, 8)
fn moveAir(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p = vec3<i32>(id); let i = index(p); let ci = columnIndex(p); let dt = u.spacingTime.w;
    let cell = volumeIn[i];
    let departure = vec2<f32>(p.xy) - cell.velocityTemperature.xy * dt / u.spacingTime.xy;
    var state = sampleState(departure,p.z);
    let left = volumeIn[index(p-vec3<i32>(1,0,0))].velocityTemperature;
    let right = volumeIn[index(p+vec3<i32>(1,0,0))].velocityTemperature;
    let bottom = volumeIn[index(p-vec3<i32>(0,1,0))].velocityTemperature;
    let top = volumeIn[index(p+vec3<i32>(0,1,0))].velocityTemperature;
    let pressureGradient = vec2<f32>(right.z-left.z,top.z-bottom.z) / (2.0*u.spacingTime.xy);
    let heatGradient = vec2<f32>(right.w-left.w,top.w-bottom.w) / (2.0*u.spacingTime.xy);
    let laplacian = (left.xy+right.xy+bottom.xy+top.xy-4.0*cell.velocityTemperature.xy) / (u.spacingTime.x*u.spacingTime.x);
    let thermalSign = select(1.0,-1.0,p.z==1);
    // Parameterize the turning response of the unresolved regional circulation.
    // A pure gradient force just reaches pressure balance and dies out; its
    // rotated part can sustain broad eddies around actual thermal contrasts.
    let thermalForce = thermalSign*u.weather.z*(0.10*heatGradient
        + 0.12*u.driving.z*vec2<f32>(-heatGradient.y,heatGradient.x));
    var velocity = state.xy + dt * (-pressureGradient + thermalForce + 0.12*laplacian);
    velocity *= exp(-dt*select(0.003,0.001,p.z==1));
    // A small map cannot generate the surrounding synoptic circulation. Supply
    // energy and momentum from that larger world, but keep ALL water internal.
    // Broad thermal environments move independently of the water sources; only
    // transported vapor and actual condensation decide where clouds/rain form.
    let upper = f32(p.z);
    let cycle = 6.2831853*u.environment.z/u.driving.y;
    let turn = u.driving.x*0.65*sin(cycle + upper*0.65);
    let angle = upper*u.weather.y*0.8 + turn;
    let regionalWind = vec2<f32>(cos(angle)*u.forcing.z-sin(angle)*u.forcing.w,
        sin(angle)*u.forcing.z+cos(angle)*u.forcing.w)*(1.0+upper*u.weather.y);
    if (u.physics.w > 0.5 && u.driving.x > 0.0) {
        velocity = mix(velocity,regionalWind,1.0-exp(-dt*0.025*u.driving.x));
        let uv = (vec2<f32>(id.xy)+0.5)/u.grid.xy;
        let travel = vec2<f32>(cycle/6.2831853,0.18*sin(cycle*0.63));
        let front = initialPattern(uv-travel)*u.regional.z;
        let thermalEnvironment = ambientTemperature(columns[ci].x)-upper*(9.0-u.convection.x*8.0)-front*7.0;
        state.w = mix(state.w,thermalEnvironment,1.0-exp(-dt*u.driving.x*select(0.004,0.022,p.z==1)));
    }
    // Exact rotation preserves speed. Turning the departure from the regional
    // flow lets pressure and thermal gradients form curved fronts and eddies.
    let rotation = dt*0.025*u.driving.z;
    let rotationReference = select(vec2<f32>(0.0),regionalWind,u.driving.x>0.0 || u.physics.w<0.5);
    let anomaly = velocity-rotationReference;
    velocity = rotationReference + vec2<f32>(cos(rotation)*anomaly.x-sin(rotation)*anomaly.y,
        sin(rotation)*anomaly.x+cos(rotation)*anomaly.y);
    // Material lifting cools a transported parcel; descending air warms again.
    let lifted = (columns[ci].x-sampleHeight(departure)) * select(1.0,0.25,p.z==1);
    state.w -= lifted * u.physics.x * u.convection.y;
    state.w += longwaveHeating[i];
    if (p.z == 0) { state.w += surfaceHeat[ci]; }
    if (u.physics.w < 0.5) {
        let upper = f32(p.z);
        let angle = upper*u.weather.y*0.8;
        let referenceWind = vec2<f32>(cos(angle)*u.forcing.z-sin(angle)*u.forcing.w,
            sin(angle)*u.forcing.z+cos(angle)*u.forcing.w)*(1.0+upper*u.weather.y);
        velocity = mix(velocity,referenceWind,1.0-exp(-dt*0.04));
        state.w = mix(state.w,ambientTemperature(columns[ci].x)-upper*(9.0-u.convection.x*8.0),1.0-exp(-dt*0.02));
    }
    velocity *= min(1.0,8.0/max(length(velocity),0.0001));
    if (u.hydrology.y > 0.5) {
        if (p.x == 0 || p.x == i32(u.grid.x)-1) { velocity.x = 0.0; }
        if (p.y == 0 || p.y == i32(u.grid.y)-1) { velocity.y = 0.0; }
    }
    state = vec4<f32>(velocity, state.z, clamp(state.w,-65.0,65.0));
    volumeOut[i] = AtmosphereCell(state,cell.moisture);
}
@compute @workgroup_size(8, 8)
fn prepareCourant(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id);
    let outward = max(faceSpeed(p,0u),0.0) + max(-faceSpeed(p-vec3<i32>(1,0,0),0u),0.0)
        + max(faceSpeed(p,1u),0.0) + max(-faceSpeed(p-vec3<i32>(0,1,0),1u),0.0);
    outgoingCourants[index(p)] = min(1.0,0.9/max(outward*u.spacingTime.w/u.spacingTime.x,0.000001));
}
fn waterFlux(p: vec3<i32>, axis: u32) -> vec4<f32> {
    var offset=vec3<i32>(0); offset[axis]=1;
    let speed=faceSpeed(p,axis);
    let donor=select(index(p),index(p+offset),speed<0.0);
    return speed * volumeIn[donor].moisture * outgoingCourants[donor];
}
@compute @workgroup_size(8, 8)
fn transport(@builtin(global_invocation_id) id: vec3<u32>) {
    if (!inside(id)) { return; }
    let p=vec3<i32>(id); let i=index(p); let dt=u.spacingTime.w;
    var cell=volumeIn[i];
    cell.moisture += (waterFlux(p-vec3<i32>(1,0,0),0u)-waterFlux(p,0u)
        + waterFlux(p-vec3<i32>(0,1,0),1u)-waterFlux(p,1u)) * dt/u.spacingTime.x;
    // Symplectic pressure update uses the already advanced velocities. Pressure
    // waves communicate changes horizontally without an iterative 3-D solve.
    let divergence=(faceSpeed(p,0u)-faceSpeed(p-vec3<i32>(1,0,0),0u)
        +faceSpeed(p,1u)-faceSpeed(p-vec3<i32>(0,1,0),1u))/u.spacingTime.x;
    let laplacian=(volumeIn[index(p+vec3<i32>(1,0,0))].velocityTemperature.z
        +volumeIn[index(p-vec3<i32>(1,0,0))].velocityTemperature.z
        +volumeIn[index(p+vec3<i32>(0,1,0))].velocityTemperature.z
        +volumeIn[index(p-vec3<i32>(0,1,0))].velocityTemperature.z-4.0*cell.velocityTemperature.z)/(u.spacingTime.x*u.spacingTime.x);
    cell.velocityTemperature.z=clamp((cell.velocityTemperature.z-4.0*divergence*dt+0.10*laplacian*dt)*exp(-dt*0.015),-8.0,8.0);
    volumeOut[i]=cell;
}
fn phase(cell: AtmosphereCell, rainEfficiency: f32) -> AtmosphereCell {
    var c=cell;
    let transfer=cloudPhaseTransfer(c.velocityTemperature.w,c.moisture.x,c.moisture.y)*(1.0-exp(-2.0*u.spacingTime.w));
    c.moisture.x-=transfer; c.moisture.y+=transfer; c.velocityTemperature.w+=transfer*cloudLatentHeat;
    let cloud=max(c.moisture.y,0.0);
    // Shallow fog is a poor rain producer. Most rain matures in the upper layer,
    // giving newly evaporated water time to leave its source before falling.
    let growth=rainEfficiency*(0.3+1.7*cloud/(cloud+0.003))/u.weather.x;
    let formed=cloud*(1.0-exp(-growth*u.spacingTime.w));
    let snow=1.0-smoothstep(-1.5,1.5,c.velocityTemperature.w);
    c.moisture.y-=formed; c.moisture.z+=formed*(1.0-snow); c.moisture.w+=formed*snow;
    let evaporated=max(0.0,-cloudPhaseTransfer(c.velocityTemperature.w,c.moisture.x,c.moisture.z))*(1.0-exp(-0.08*u.spacingTime.w));
    c.moisture.z-=evaporated; c.moisture.x+=evaporated; c.velocityTemperature.w-=evaporated*cloudLatentHeat;
    return c;
}
@compute @workgroup_size(8, 8)
fn microphysics(@builtin(global_invocation_id) id: vec3<u32>) {
    if (any(id.xy >= vec2<u32>(u.grid.xy))) { return; }
    let ci=id.y*u32(u.grid.x)+id.x; let hi=ci+u32(u.grid.x*u.grid.y); let dt=u.spacingTime.w;
    var low=volumeOut[ci]; var high=volumeOut[hi];
    low.moisture.x+=columns[ci].z*columns[ci].w*u.environment.y/u.spacingTime.z;
    let p=vec3<i32>(vec2<i32>(id.xy),0);
    let slope=vec2<f32>(columns[columnIndex(p+vec3<i32>(1,0,0))].x-columns[columnIndex(p-vec3<i32>(1,0,0))].x,
        columns[columnIndex(p+vec3<i32>(0,1,0))].x-columns[columnIndex(p-vec3<i32>(0,1,0))].x)/(2.0*u.spacingTime.xy);
    let lift=max(dot(low.velocityTemperature.xy,slope),0.0)*u.convection.y;
    let instability=max(low.velocityTemperature.w-high.velocityTemperature.w-5.0,0.0);
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
    if (u.physics.w < 0.5 && u.hydrology.x < 0.5) {
        low.moisture.x=mix(low.moisture.x,saturation(low.velocityTemperature.w)*u.forcing.y,1.0-exp(-dt*0.015));
        high.moisture.x=mix(high.moisture.x,saturation(high.velocityTemperature.w)*u.forcing.y,1.0-exp(-dt*0.015));
    }
    low=phase(low,0.2); high=phase(high,1.0);
    let upperFall=high.moisture.zw*(vec2<f32>(1.0)-exp(-dt/vec2<f32>(u.physics.y,u.physics.z)));
    high.moisture.z-=upperFall.x; high.moisture.w-=upperFall.y;
    low.moisture.z+=upperFall.x; low.moisture.w+=upperFall.y;
    // Snow falling through warm lower air melts with a paired latent heat debit.
    let melted=min(low.moisture.w,max(low.velocityTemperature.w,0.0)/80.0*(1.0-exp(-dt*0.2)));
    low.moisture.w-=melted; low.moisture.z+=melted; low.velocityTemperature.w-=melted*80.0;
    let fallen=low.moisture.zw*(vec2<f32>(1.0)-exp(-dt/vec2<f32>(u.physics.y,u.physics.z)));
    low.moisture.z-=fallen.x; low.moisture.w-=fallen.y;
    precipitation[ci]=fallen*u.spacingTime.z/u.environment.y;
    let rainRate=(fallen.x+fallen.y)*u.spacingTime.z/u.environment.y/max(dt,0.000001);
    // Wetness is a diagnostic memory of rainfall, never an extra water source.
    var wet=weatherMap[ci].x*exp(-dt/180.0);
    wet=1.0-(1.0-wet)*exp(-rainRate*dt*700.0);
    let cover=1.0-exp(-(low.moisture.y+high.moisture.y)*160.0);
    weatherMap[ci]=vec4<f32>(wet,rainRate,mixing,cover);
    volumeOut[ci]=low; volumeOut[hi]=high;
}
fn surfaceWeather(mapping: SurfaceMapping, height: f32) -> vec4<f32> {
    let f=mapping.fraction; var result=vec4<f32>(0.0);
    for (var y=0;y<2;y++) { for(var x=0;x<2;x++) {
        let ci=mapping.columns[y*2+x]; let w=select(1.0-f,f,vec2<bool>(x==1,y==1)); let weight=w.x*w.y;
        let cell=volumeIn[ci];
        result+=vec4<f32>(cell.velocityTemperature.w-u.physics.x*(height-columns[ci].x),
            cell.moisture.x,precipitation[ci]*depositionWeights[ci])*weight;
    }}
    return result;
}
fn surfaceTransmission(mapping: SurfaceMapping) -> f32 {
    let f=mapping.fraction; var cloud=0.0; let n=u32(u.grid.x*u.grid.y);
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){
        let ci=mapping.columns[y*2+x]; let w=select(1.0-f,f,vec2<bool>(x==1,y==1));
        cloud+=(volumeIn[ci].moisture.y+volumeIn[ci+n].moisture.y)*w.x*w.y;
    }}
    return 1.0-u.weather.w*(1.0-exp(-cloud*160.0));
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

// Return raw absorption and its contrast weight. The score is the local warming
// tendency (absorption / capacity), so high-absorptivity deep water does not
// automatically take energy away from the more responsive dry land.
fn solarWeights(pos: vec2<i32>) -> vec2<f32> {
    let i = u32(pos.y) * u32(u.grid.w) + u32(pos.x);
    let cover = surface[i];
    let liquid = max(fluids[i].x, 0.0);
    let albedo = materialAlbedo(terrain[i].sand, terrain[i].soil, liquid, cover.y, cover.x);
    let normal = normalize(vec3<f32>(
        terrainElevation(pos - vec2<i32>(1, 0)) - terrainElevation(pos + vec2<i32>(1, 0)),
        terrainElevation(pos - vec2<i32>(0, 1)) - terrainElevation(pos + vec2<i32>(0, 1)), 400.0 / u.grid.w));
    let exposure = max(0.0, dot(normal, u.radiation.xyz));
    let absorbed = (1.0 - albedo) * exposure * 0.65;
    let response = clamp((1.0 - albedo) * exposure / surfaceHeatCapacity(i, liquid, cover.y, cover.x), 0.0, 1.0);
    // Positive, bounded sharpening. No artificial heating of unlit cells and no
    // unstable powers near sunset; normalization below restores the raw budget.
    let shaped = absorbed * exp((u.hydrology.w - 1.0) * (response - 1.0));
    return vec2<f32>(absorbed, shaped);
}

var<workgroup> solarSum: array<vec2<f32>, 256>;

fn sumSolar(lane: u32) {
    workgroupBarrier();
    for (var stride = 128u; stride > 0u; stride /= 2u) {
        if (lane < stride) { solarSum[lane] += solarSum[lane + stride]; }
        workgroupBarrier();
    }
}

@compute @workgroup_size(16, 16)
fn prepareSolar(@builtin(global_invocation_id) id: vec3<u32>,
    @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    var value = vec2<f32>(0.0);
    if (all(id.xy < vec2<u32>(u32(u.grid.w)))) { value = solarWeights(vec2<i32>(id.xy)); }
    solarSum[lane] = value;
    sumSolar(lane);
    if (lane == 0u) { solarPartials[group.y * ((u32(u.grid.w) + 15u) / 16u) + group.x] = solarSum[0]; }
}

@compute @workgroup_size(256)
fn normalizeSolar(@builtin(local_invocation_index) lane: u32) {
    let groups = (u32(u.grid.w) + 15u) / 16u;
    var total = vec2<f32>(0.0);
    for (var i = lane; i < groups * groups; i += 256u) { total += solarPartials[i]; }
    solarSum[lane] = total;
    sumSolar(lane);
    if (lane == 0u) {
        let sums = solarSum[0];
        radiationBudget[0] = vec4<f32>(sums.x / max(sums.y, 1e-20), sums / (u.grid.w * u.grid.w), 0.0);
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
            let conductance = 0.45 * mixing / insulation;
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
// wall and wrapped neighbors at periodic edges. Convert fine-cell surface energy
// to the receiving air cell's temperature using physical areas, not bucket sizes.
@compute @workgroup_size(64)
fn gatherHeat(@builtin(workgroup_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let n = vec2<u32>(u.grid.xy);
    if (any(id.xy >= n)) { return; }
    let fine = i32(u.grid.w);
    let ci = id.y * n.x + id.x;
    var start = vec2<i32>(ceil((vec2<f32>(id.xy) - 0.5) * u.grid.w / u.grid.xy - 0.5));
    var end = vec2<i32>(ceil((vec2<f32>(id.xy) + 1.5) * u.grid.w / u.grid.xy - 0.5));
    if (u.hydrology.y > 0.5) {
        start = max(start, vec2<i32>(0));
        end = min(end, vec2<i32>(fine));
    }
    let extent = end - start;
    var heat = vec2<f32>(0.0);
    for (var k = i32(lane); k < extent.x * extent.y; k += 64) {
        let unfolded = start + vec2<i32>(k % extent.x, k / extent.x);
        let q = ((unfolded % vec2<i32>(fine)) + vec2<i32>(fine)) % vec2<i32>(fine);
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

fn surfaceDownwardLongwave(mapping: SurfaceMapping) -> f32 {
    let f = mapping.fraction;
    var flux = 0.0;
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let weight = select(1.0 - f, f, vec2<bool>(x == 1, y == 1));
            flux += weight.x * weight.y * radiationBudget[mapping.columns[y * 2 + x] + 1u].y;
        }
    }
    return flux;
}

// Each invocation owns exactly one fine cell. No neighboring fluids are read
// or written, so the existing fluid buffer can safely be updated in place.
@compute @workgroup_size(16, 16)
fn surfaceExchange(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = u32(u.grid.w);
    if (id.x >= n || id.y >= n) { return; }
    let i = id.y * n + id.x;
    let dt = u.spacingTime.w;
    // Use the same material state as prepareSolar, before precipitation and
    // phase changes alter its cover. No CPU readback or additional solar source.
    let mapping = surfaceMapping(id.xy);
    let absorbedSolar = u.environment.x * solarWeights(vec2<i32>(id.xy)).y * radiationBudget[0].x * surfaceTransmission(mapping);
    var cover = surface[i];
    var liquid = fluids[i];
    let height = (terrain[i].rock + terrain[i].soil + terrain[i].sand + max(liquid.x, 0.0) + max(liquid.y, 0.0) + cover.x * 5.0 + cover.y / 0.917) * u.environment.y;
    // Use the same pre-phase surface emission gathered for the air budget.
    let netLongwave = surfaceDownwardLongwave(mapping) - longwaveEmission(cover.z);
    let weather = surfaceWeather(mapping, height);
    let airTemperature = weather.x;
    let vapor = weather.y;
    let fallen = weather.zw;
    liquid.x = max(liquid.x, 0.0);
    cover.x = max(cover.x, 0.0);
    cover.y = max(cover.y, 0.0);
    let latentFusion = 80.0;
    var energy = cover.z * surfaceHeatCapacity(i, liquid.x, cover.y, cover.x);
    liquid.x += fallen.x;
    cover.x += fallen.y;
    energy += fallen.x * 8.0 * airTemperature + fallen.y * 2.0 * min(airTemperature, 0.0);
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
    let lavaHeat = min(max(liquid.y, 0.0) * 120.0, 70.0) * 0.35;
    energy += (absorbedSolar + netLongwave + lavaHeat) * dt;
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
    let evaporation = min(max(liquid.x, 0.0) * (1.0 - exp(-rate * dt / 45.0)), deficit * dt * rate);
    liquid.x = max(liquid.x - evaporation, 0.0);
    energy -= evaporation * (450.0 + 8.0 * cover.z);
    cover.z = clamp(energy / surfaceHeatCapacity(i, liquid.x, cover.y, cover.x), -70.0, 90.0);
    // microphysics consumed the previous pending evaporation this step. Steam
    // from the surface fluid solver joins the same conserved water reservoir.
    cover.w = evaporation + max(liquid.w, 0.0);
    liquid.w = 0.0;
    surface[i] = cover;
    fluids[i] = liquid;
}
