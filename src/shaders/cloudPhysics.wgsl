// Shared condensate scale for microphysics and volume extinction. These are
// simulation units, not meteorological liquid water contents or droplet sizes.
const cloudWaterScale: f32 = 0.001;
const cloudLatentHeat: f32 = 480.0;

fn cloudSaturation(temperature: f32) -> f32 {
    return clamp(0.008 * exp(0.065 * temperature), 0.0001, 0.1);
}

fn cloudPhaseTransfer(temperature: f32, vapor: f32, condensate: f32) -> f32 {
    // Solve qv - transfer = saturation(T + L * transfer). The physical bounds
    // allow complete evaporation if there is too little water for saturation.
    // No evaporation timer or external humidity reservoir is involved.
    var transfer = 0.0;
    for (var iteration = 0u; iteration < 4u; iteration++) {
        let raw = 0.008 * exp(0.065 * (temperature + cloudLatentHeat * transfer));
        let saturated = clamp(raw, 0.0001, 0.1);
        let derivative = select(0.0, 0.065 * saturated, raw > 0.0001 && raw < 0.1);
        transfer = clamp(transfer + (vapor - transfer - saturated) /
            (1.0 + cloudLatentHeat * derivative), -condensate, vapor);
    }
    return transfer;
}

fn cloudConversionRate(condensate: f32) -> f32 {
    // Gradual coalescence, with no inactive band below a hard rain threshold.
    // Thin fog drains slowly; denser clouds turn over on a minute-scale clock.
    let water = max(condensate, 0.0);
    return 0.018 * water / (water + cloudWaterScale);
}

fn cloudExtinction(condensate: f32) -> f32 {
    // Optical depth is this coefficient times actual ray length. At the
    // coalescence scale, a 10-unit layer is a translucent veil (~16% opacity).
    // No water is hidden/deleted by a rendering density cutoff.
    return 0.018 * max(condensate, 0.0) / cloudWaterScale;
}
