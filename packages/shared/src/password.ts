/**
 * 密码规则与强度评估（前端实时提示与服务端最低门槛共用同一份实现，避免"前端说强、后端拒绝"）。
 *
 * 分级口径（不数长度单项，按"有效搜索空间"估算）：
 * 1. 字符类池：小写 26 / 大写 26 / 数字 10 / 符号 32 / 空格 1 / 汉字等其他 1000，
 *    把实际出现的类的大小相加取 log2，得到每字符的熵增量——种类多才真的变强，不是简单加分。
 * 2. 可预测片段：同字符连写、重复片段、递增递减序列、键盘顺序（qwerty/asdf）先被识别出来，
 *    吃掉多少字符就从有效长度里扣掉，只保留 2 位"种子"熵。
 * 3. 词表：常见口令与项目品牌词（白板 / 樱花 / sakura / shiro …）先做常见替换归一化
 *    （@→a、0→o、1→l、$→s、3→e、4→a、5→s）再去匹配，`Passw0rd!` 不会被当成强密码。
 * 4. 长度仍是主权重之一，但种类单一或模式有硬伤时会被压档，见 ASSESSMENT 下方的封顶规则。
 *
 * 硬门槛只有四条：长度越界、纯空白、等同内置弱口令表、与邮箱前缀相同。
 * 其余只给建议、不阻断——弱的密码允许注册（NIST SP 800-63B 的做法，
 * 避免用户为了过校验去写 "Password1!"）。分数与档位只用于界面提示，**不落库**。
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 32;

export type PasswordLevel = 'weak' | 'fair' | 'strong' | 'very-strong';

/**
 * 四档阈值：估算熵（bit）达到该值才进入对应档位。
 * weak < 36 ≤ fair < 52 ≤ strong < 68 ≤ very-strong
 */
export const PASSWORD_LEVEL_BITS = {
  fair: 36,
  strong: 52,
  veryStrong: 68,
} as const;

export interface PasswordAssessment {
  /** 0–100，按估算熵缩放，仅用于界面强弱条 */
  score: number;
  level: PasswordLevel;
  /** 为什么是这个档：按重要度排序的短句，可直接展示（如「缺少符号」「含键盘顺序」） */
  reasons: string[];
  /** 非空时不允许提交（服务端同样拒绝） */
  blockers: string[];
  /** 当前档位下最值得改的一件事；null 表示已无可建议 */
  hint: string | null;
  /** 码点长度，供 UI 显示剩余位数 */
  length: number;
}

/** 常见弱口令与项目相关品牌词：先归一化再比对，整串命中即拒绝。 */
const COMMON_PASSWORDS = new Set([
  'password', 'passwort', 'password1', 'password123', 'passw0rd',
  '123456', '1234567', '12345678', '123456789', '1234567890', '0123456789', '12345678910',
  'qwerty', 'qwertyuiop', 'qwerty123', '1qaz2wsx', 'zaq12wsx', 'asdfgh', 'asdfghjkl', 'zxcvbnm',
  'iloveyou', 'letmein', 'welcome', 'admin', 'administrator', 'root',
  'trustno1', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'starwars',
  'whatever', 'computer', 'internet', 'woaini1314', '5201314520',
  // 项目相关：品牌名、产品名、站点吉祥物
  'sakura', 'sakura123', 'sakura2024', 'sakurawhiteboard', 'shiro', 'whiteboard',
  'excalidraw', 'fujisan', 'fuji2024', 'konnichiwa', '樱花', '桜花', '桜', '白板',
]);

/** 出现在密码任意位置就足以说明"猜得出来"的词：ASCII 至少 5 位，汉字至少 2 位。 */
const GUESSABLE_TOKENS = [...COMMON_PASSWORDS].filter(
  (token) => (token.length >= 5 && /^[a-z0-9]+$/.test(token)) || /[\u4e00-\u9fff]{2,}/.test(token),
);

/** 常见替换：归一化后再查词表，避免 Passw0rd! 这类被误判为强。 */
const LEET_SUBSTITUTIONS: Record<string, string> = {
  '@': 'a',
  '0': 'o',
  '1': 'l',
  '$': 's',
  '3': 'e',
  '4': 'a',
  '5': 's',
};

type CharClass = 'lower' | 'upper' | 'digit' | 'symbol' | 'space' | 'other';

/** 每类字符的池大小：相加后取 log2 就是该密码每字符的熵增量 */
const CLASS_POOL: Record<CharClass, number> = {
  lower: 26,
  upper: 26,
  digit: 10,
  symbol: 32,
  space: 1,
  other: 1000,
};

const CLASS_LABEL: Record<CharClass, string> = {
  lower: '小写字母',
  upper: '大写字母',
  digit: '数字',
  symbol: '符号',
  space: '空格',
  other: '汉字等其他字符',
};

/** 键盘横向顺序，用来识别 qwerty / asdf 一类"手指滑过去"的片段 */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** 长度 ≥ 4 的键盘片段（含反向），O(1) 命中 */
const KEYBOARD_PIECES = (() => {
  const pieces = new Set<string>();
  for (const row of KEYBOARD_ROWS) {
    for (const sequence of [row, [...row].reverse().join('')]) {
      for (let start = 0; start < sequence.length; start += 1) {
        for (let end = start + 4; end <= sequence.length; end += 1) {
          pieces.add(sequence.slice(start, end));
        }
      }
    }
  }
  return pieces;
})();

const LEVEL_ORDER: PasswordLevel[] = ['weak', 'fair', 'strong', 'very-strong'];

function codeOf(value: string): number {
  return value.codePointAt(0) ?? 0;
}

function classOf(value: string): CharClass {
  if (value >= 'a' && value <= 'z') return 'lower';
  if (value >= 'A' && value <= 'Z') return 'upper';
  if (value >= '0' && value <= '9') return 'digit';
  if (value === ' ') return 'space';
  const code = codeOf(value);
  return code > 0x20 && code < 0x7f ? 'symbol' : 'other';
}

function normalizeForDictionary(value: string): string {
  let substituted = '';
  for (const ch of value.toLowerCase()) substituted += LEET_SUBSTITUTIONS[ch] ?? ch;
  // 去掉符号与空格再比对：P@ssw0rd! → password
  return substituted.replace(/[^0-9a-z\u4e00-\u9fff]/gu, '');
}

interface PatternScan {
  /** 被可预测模式覆盖的字符数 */
  covered: number;
  /** 命中的模式名，按扫描顺序（重复 → 键盘 → 序列） */
  labels: string[];
}

/**
 * 找出可预测片段。数字 / 字母一律按小写扫描；每个字符只会被计一次，
 * 避免 "1234" 同时被当成序列和键盘顺序重复扣分。
 */
function scanPatterns(value: string): PatternScan {
  const chars = [...value.toLowerCase()];
  const mask = new Array<boolean>(chars.length).fill(false);
  const labels: string[] = [];
  const mark = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) mask[index] = true;
  };
  const label = (text: string) => {
    if (!labels.includes(text)) labels.push(text);
  };

  for (let start = 0; start < chars.length; ) {
    let end = start;
    while (end + 1 < chars.length && chars[end + 1] === chars[start]) end += 1;
    if (end - start + 1 >= 3) {
      mark(start, end + 1);
      label('含重复字符');
    }
    start = end + 1;
  }

  for (let start = 0; start < chars.length; start += 1) {
    let matched = 0;
    for (let period = 2; period <= 8 && start + period * 2 <= chars.length; period += 1) {
      const block = chars.slice(start, start + period).join('');
      if (new Set(block).size === 1) continue; // 同字符连写已由上一段处理
      let copies = 1;
      while (
        start + (copies + 1) * period <= chars.length &&
        chars.slice(start + copies * period, start + (copies + 1) * period).join('') === block
      ) {
        copies += 1;
      }
      if (copies >= 2) matched = Math.max(matched, copies * period);
    }
    if (matched >= 4) {
      mark(start, start + matched);
      label('含重复片段');
      start += matched - 1;
    }
  }

  const flat = chars.join('');
  for (let start = 0; start < flat.length; start += 1) {
    for (let size = Math.min(10, flat.length - start); size >= 4; size -= 1) {
      if (!KEYBOARD_PIECES.has(flat.slice(start, start + size))) continue;
      mark(start, start + size);
      label('含键盘顺序');
      start += size - 1;
      break;
    }
  }

  for (let start = 0; start < chars.length; ) {
    const step = start + 1 < chars.length ? codeOf(chars[start + 1] ?? '') - codeOf(chars[start] ?? '') : 0;
    let end = start;
    if (step === 1 || step === -1) {
      while (end + 1 < chars.length && codeOf(chars[end + 1] ?? '') - codeOf(chars[end] ?? '') === step) end += 1;
    }
    if (end - start + 1 >= 3) {
      mark(start, end + 1);
      label('含递增/递减序列');
      start = end + 1;
      continue;
    }
    start += 1;
  }

  return { covered: mask.filter(Boolean).length, labels };
}

function levelOfBits(bits: number): PasswordLevel {
  if (bits < PASSWORD_LEVEL_BITS.fair) return 'weak';
  if (bits < PASSWORD_LEVEL_BITS.strong) return 'fair';
  if (bits < PASSWORD_LEVEL_BITS.veryStrong) return 'strong';
  return 'very-strong';
}

function atMost(level: PasswordLevel, cap: PasswordLevel): PasswordLevel {
  return LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(cap) ? cap : level;
}

/** 封顶后仍让分数落在该档区间内，避免条走满却写着"一般" */
function scoreFor(bits: number, level: PasswordLevel): number {
  const raw = Math.min(100, Math.round(bits));
  switch (level) {
    case 'weak':
      return Math.min(raw, PASSWORD_LEVEL_BITS.fair - 1);
    case 'fair':
      return Math.max(PASSWORD_LEVEL_BITS.fair, Math.min(raw, PASSWORD_LEVEL_BITS.strong - 1));
    case 'strong':
      return Math.max(PASSWORD_LEVEL_BITS.strong, Math.min(raw, PASSWORD_LEVEL_BITS.veryStrong - 1));
    default:
      return Math.max(PASSWORD_LEVEL_BITS.veryStrong, raw);
  }
}

/**
 * 评估密码：返回估算熵、档位、为什么是这个档、硬性问题与一条改进建议。
 * `email` 只用于"不要用邮箱前缀做密码"这一条，缺少时跳过。
 */
export function assessPassword(password: string, options: { email?: string | null } = {}): PasswordAssessment {
  const chars = [...password];
  const length = chars.length;
  const blockers: string[] = [];
  const classes = new Set<CharClass>();
  for (const ch of chars) classes.add(classOf(ch));

  if (password.trim().length === 0) blockers.push('密码不能只有空格');
  else if (length < PASSWORD_MIN_LENGTH) blockers.push(`密码至少 ${PASSWORD_MIN_LENGTH} 位，还差 ${PASSWORD_MIN_LENGTH - length} 位`);
  else if (length > PASSWORD_MAX_LENGTH) blockers.push(`密码最多 ${PASSWORD_MAX_LENGTH} 位`);

  const normalized = normalizeForDictionary(password);
  const dictionaryExact = COMMON_PASSWORDS.has(normalized);
  if (dictionaryExact) blockers.push('这个密码太常见，换一个');
  const guessedToken = dictionaryExact ? null : (GUESSABLE_TOKENS.find((token) => normalized.includes(token)) ?? null);

  const local = options.email?.split('@')[0]?.trim().toLowerCase() ?? '';
  const containsEmailLocal = local.length >= 4 && password.toLowerCase().includes(local);
  if (containsEmailLocal) blockers.push('不要用邮箱前缀做密码');

  // 1. 有效搜索空间：出现的字符类池相加 → 每字符熵
  const pool = [...classes].reduce((sum, key) => sum + CLASS_POOL[key], 0);
  const bitsPerChar = pool > 1 ? Math.log2(pool) : 0;

  // 2. 可预测片段只保留 2 位"种子"熵，其余从有效长度里扣掉
  const pattern = scanPatterns(password);
  const effectiveLength = pattern.covered > 0 ? Math.min(length, length - pattern.covered + 2) : length;
  const bits = Math.max(0, effectiveLength * bitsPerChar);

  const singleClass = classes.size === 1;
  const onlyDigits = singleClass && classes.has('digit');

  // 3. 封顶：词表命中 → 底档；纯数字 → 最多一般；单一字符类 / 模式吃掉 1/3 以上 → 不给顶档
  let level = levelOfBits(bits);
  if (dictionaryExact || guessedToken || containsEmailLocal) level = 'weak';
  else if (onlyDigits) level = atMost(level, 'fair');
  else if (singleClass) level = atMost(level, length >= 16 ? 'strong' : 'fair');
  else if (pattern.covered * 3 >= length) level = atMost(level, 'fair');

  const reasons: string[] = [];
  if (dictionaryExact) reasons.push('命中常见密码');
  else if (guessedToken) reasons.push(`含常见词「${guessedToken}」`);
  if (containsEmailLocal) reasons.push('含邮箱前缀');
  reasons.push(...pattern.labels);
  if (onlyDigits) reasons.push('只有数字');
  else if (singleClass) reasons.push(`只有${CLASS_LABEL[[...classes][0] ?? 'other']}`);
  if (!singleClass) {
    if (!classes.has('upper')) reasons.push('缺少大写字母');
    if (!classes.has('digit')) reasons.push('缺少数字');
    if (!classes.has('symbol')) reasons.push('缺少符号');
  }
  if (level !== 'very-strong' && length < 12) reasons.push(`长度只有 ${length} 位`);

  return {
    score: scoreFor(bits, level),
    level,
    reasons: reasons.slice(0, 4),
    blockers,
    hint: hintOf(level, reasons, length),
    length,
  };
}

function hintOf(level: PasswordLevel, reasons: string[], length: number): string | null {
  if (level === 'very-strong') return null;
  for (const reason of reasons) {
    if (reason.startsWith('命中常见密码')) return '换一个与站点、品牌、姓名都无关的词';
    if (reason.startsWith('含常见词')) return '把其中的常见词换掉，别用品牌名';
    if (reason === '含邮箱前缀') return '别用邮箱前缀，换一段不相关的词';
    if (reason === '含键盘顺序') return '别用 qwerty / asdf 这类键盘顺序';
    if (reason === '含递增/递减序列') return '别用 1234 / abcd 这类连续序列';
    if (reason === '含重复片段' || reason === '含重复字符') return '去掉重复片段，换成不重复的内容';
    if (reason === '只有数字') return '加字母与符号，纯数字最容易被猜';
    if (reason === '只有符号' || reason === '只有空格') return '加上字母和数字';
    if (reason.startsWith('只有')) return '混用大小写数字符号，别只用一类字符';
    if (reason === '缺少符号') return '加一个符号（如 ! # $）';
    if (reason === '缺少数字') return '加一个数字';
    if (reason === '缺少大写字母') return '加一个大写字母';
  }
  if (length < 12) return `再加 ${12 - length} 位会更稳`;
  return '可以直接注册';
}

/** 界面上的四段条：档位 → 点亮格数 */
export function levelBars(level: PasswordLevel): number {
  switch (level) {
    case 'weak':
      return 1;
    case 'fair':
      return 2;
    case 'strong':
      return 3;
    default:
      return 4;
  }
}

/** 档位 → 中文标签 */
export function levelLabel(level: PasswordLevel): string {
  switch (level) {
    case 'weak':
      return '弱';
    case 'fair':
      return '一般';
    case 'strong':
      return '较强';
    default:
      return '强';
  }
}
