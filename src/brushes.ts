/** Right click removes the selected material or reverses an active power. */
export function inverseBrush(type: number): number {
  return [13, 14, 15, 4, 3, 5, 17, 8, 7, 16, 12, 18][type] ?? 5;
}

export function changesWaterInventory(type: number): boolean {
  return [0, 5, 6, 13, 17].includes(type);
}
