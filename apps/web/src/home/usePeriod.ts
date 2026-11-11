import { useEffect, useState } from "react";

export type Period = "dawn" | "day" | "dusk" | "night";

/** 按本地时间判定时辰：黎明 5–8、白天 8–16、黄昏 16–19、其余为夜 */
export function resolvePeriod(hour: number): Period {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 16) return "day";
  if (hour >= 16 && hour < 19) return "dusk";
  return "night";
}

/** 跟随本机时钟每分钟刷新一次时辰；首页与登录页共用同一套色温 */
export function usePeriod(): Period {
  const [period, setPeriod] = useState<Period>(() => resolvePeriod(new Date().getHours()));

  useEffect(() => {
    const timer = window.setInterval(() => setPeriod(resolvePeriod(new Date().getHours())), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return period;
}
