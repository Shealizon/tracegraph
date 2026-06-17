// =============================================================================
// import/texGeneric.js  —  通用 TeX 本地导入（自动识别，无需固定格式 / 无外部依赖）
//
// 不再要求论文是「固定格式」：
//   * 通过 \newtheorem{env}[..]{Printed Name} 自动发现自定义定理类环境及其显示名；
//   * 再把正文中实际出现的常见环境（corollary/definition/... ）一并纳入；
//   * 复用 extractFixedTexGraph 的本地解析（label/ref/cite/编号），全部在浏览器执行。
// =============================================================================
import { extractFixedTexGraph } from './texExtract.js';

const COMMON_ENVS = {
  theorem: 'Theorem',
  proposition: 'Proposition',
  lemma: 'Lemma',
  corollary: 'Corollary',
  definition: 'Definition',
  claim: 'Claim',
  conjecture: 'Conjecture',
  remark: 'Remark',
  observation: 'Observation',
  example: 'Example',
};

// 解析 \newtheorem{env}[counter]{Printed}[parent] —— 收集自定义环境名与显示名
export function detectTheoremEnvs(tex) {
  const labels = {};
  const re = /\\newtheorem\*?\s*\{([^}]+)\}(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(tex)) !== null) labels[m[1].trim()] = m[2].trim();
  return labels;
}

export function extractGenericTexGraph(tex, auxText = '', opts = {}) {
  const declared = detectTheoremEnvs(tex);
  const envSet = new Set(Object.keys(declared));
  // 正文中实际出现的常见环境也纳入（即便没有 \newtheorem 声明）
  for (const env of Object.keys(COMMON_ENVS)) {
    if (new RegExp(`\\\\begin\\{${env}\\}`).test(tex)) envSet.add(env);
  }
  // 兜底：什么都没识别到时退回最常见三类
  if (envSet.size === 0) ['theorem', 'proposition', 'lemma'].forEach((e) => envSet.add(e));

  const envs = [...envSet];
  const typeLabels = {};
  for (const env of envs) typeLabels[env] = declared[env] || COMMON_ENVS[env] || cap(env);

  return extractFixedTexGraph(tex, auxText, { ...opts, envs, typeLabels });
}

function cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : s; }
