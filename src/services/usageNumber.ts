const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

export const formatUsageNumber = (value: number, locale: string) => {
  const amount = Number.isFinite(value) ? value : 0;
  const absolute = Math.abs(amount);
  const roundedThousands = Math.round((absolute / THOUSAND) * 10) / 10;
  const roundedMillions = Math.round((absolute / MILLION) * 10) / 10;
  const useBillions = absolute >= BILLION || roundedMillions >= 1_000;
  const useMillions = !useBillions && (absolute >= MILLION || roundedThousands >= 1_000);
  const useThousands = !useBillions && !useMillions && absolute >= THOUSAND;
  const divisor = useBillions ? BILLION : useMillions ? MILLION : useThousands ? THOUSAND : 1;
  const unit = useBillions ? "B" : useMillions ? "M" : useThousands ? "K" : "";
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: divisor === 1 ? 0 : 1,
  }).format(amount / divisor);

  return `${formatted}${unit}`;
};

export const formatDuration = (value: number, locale: string) => {
  const milliseconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (milliseconds < 1_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(milliseconds)} ms`;
  }
  const seconds = milliseconds / 1_000;
  const maximumFractionDigits = seconds >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits: seconds >= 10 ? 0 : 1,
  }).format(seconds)} s`;
};
