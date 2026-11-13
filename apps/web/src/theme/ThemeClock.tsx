import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { usePeriod, type Period } from "../home/usePeriod";

/**
 * 全站唯一的「时辰钟」。
 *
 * 首页原有的 usePeriod 是唯一时间源，这里只调用一次，然后把结果同时做三件事：
 *   1. 写 <html data-period>：tokens.css 里 dawn / dusk / night 的天空与表面层按它换档；
 *   2. 写 <html data-theme="light|night">：只给「表面色板」用的派生属性，
 *      避免每个页面都写四档选择器；
 *   3. 跨档时开一个 3 秒的 data-theme-shift 窗口：ui.css / pages.css 里所有
 *      「只在这个窗口生效」的 2.8s 颜色过渡挂在这个属性上，平时不拖慢 hover。
 *
 * 写在 <html> 而不是某个页面根节点：toast、遮罩、确认弹窗、Excalidraw 自己的
 * DOM 都会挂到 body 或更外层，写在 .wb-page 上会有节点继承不到 token。
 */
const PeriodContext = createContext<Period>("day");

/** 时钟自己的 context：页面只读，不各自再起一份 60s 定时器 */
export function useThemePeriod(): Period {
  return useContext(PeriodContext);
}

/** 过渡窗口比 2.8s 略长，保证最后一帧的过渡能走完 */
const SHIFT_MS = 3000;

const themeOf = (period: Period) => (period === "night" ? "night" : "light");

export function ThemeClock({ children }: { children: React.ReactNode }) {
  const period = usePeriod();
  const prevPeriod = useRef(period);

  // useLayoutEffect：在首次绘制前写入，刷新页面不会先闪一帧白天
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.period = period;
    root.dataset.theme = themeOf(period);
  }, [period]);

  useEffect(() => {
    // 用前值比较而不是「首次挂载」标记：StrictMode 下 effect 会跑两遍，
    // 用标记会在开发环境每次挂载都误开 3s 过渡窗口（虽然颜色没变看不出，
    // 但会把 hover 的 120ms 过渡暂时拖成 2.8s）。
    if (prevPeriod.current === period) return;
    prevPeriod.current = period;

    // reduce 下不做过渡：和首页 skyClock 的 snap() 一致，跨档瞬间完成
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const root = document.documentElement;
    root.dataset.themeShift = "";
    const timer = window.setTimeout(() => {
      delete root.dataset.themeShift;
    }, SHIFT_MS);

    return () => {
      window.clearTimeout(timer);
      delete root.dataset.themeShift;
    };
  }, [period]);

  return <PeriodContext.Provider value={period}>{children}</PeriodContext.Provider>;
}
