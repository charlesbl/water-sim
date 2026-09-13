// A single propagation law keeps transported terrain and the visible cloud front together.
fn nukeProgress(age: f32) -> f32 {
    return clamp(age / NUKE_SHOCK_SECONDS, 0.0, 1.0);
}
fn nukeFront(age: f32) -> f32 {
    return 0.035 + 0.965 * pow(nukeProgress(age), 0.72);
}
fn nukePressure(distance: f32, radius: f32, age: f32, cell_width: f32) -> f32 {
    let front = radius * nukeFront(age);
    let width = max(radius * 0.14, cell_width * 1.5);
    // The trailing side excavates; its outgoing material piles up at the leading edge.
    let envelope = (1.0 - smoothstep(radius * 0.88, radius, distance))
        * (1.0 - smoothstep(0.78, 1.0, nukeProgress(age)));
    return exp(-pow((distance - front) / width, 2.0)) * envelope;
}
