// Effective surface properties at the illustrative scene scale. Shared by the
// atmospheric exchanges, freezing/melting and the surface brushes.
fn sedimentCoverage(sediment: f32) -> f32 {
    return smoothstep(0.0001, 0.05, max(sediment, 0.0));
}

fn materialHeatCapacity(sand: f32, soil: f32, liquid: f32, ice: f32, snow: f32) -> f32 {
    // A shallow dry sand or soil layer reacts faster than exposed rock. Water/ice/snow
    // add their actual reservoir capacities, including buried bottom ice.
    return mix(1.5, 0.6, sedimentCoverage(sand + soil)) + max(liquid, 0.0) * 8.0
        + max(ice, 0.0) * 5.0 + max(snow, 0.0) * 2.0;
}

fn materialAlbedo(sand: f32, soil: f32, liquid: f32, ice: f32, snow: f32) -> f32 {
    var albedo = mix(0.18, 0.38, sedimentCoverage(sand + soil));
    albedo = mix(albedo, 0.55, smoothstep(0.0, 0.01, max(ice, 0.0)));
    albedo = mix(albedo, 0.82, clamp(snow * 300.0, 0.0, 1.0));
    // Liquid covers the anchored ice. A thin film transitions continuously.
    return mix(albedo, 0.08, smoothstep(0.0001, 0.01, max(liquid, 0.0)));
}
