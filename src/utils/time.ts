export function seconds(num: number): number {
  return num * 1000;
}

export function minutes(num: number): number {
  return seconds(num * 60);
}
