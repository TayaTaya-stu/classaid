const rootHref = new URL('../', import.meta.url).href

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true }
  }
  if (specifier === '@/lib/supabase-admin') {
    const code = `
      const fallback = {
        from: (table) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
              single: async () => ({ data: null, error: null }),
            }),
          }),
          upsert: async () => ({ data: null, error: null }),
        }),
        rpc: async (fn, params) => ({ data: null, error: null }),
      };
      export const supabaseAdmin = new Proxy({}, {get:(_target,key)=>{const source=globalThis.__SUPPORTALK_TEST_ADMIN__||fallback;return source[key];}});
    `
    return {
      url: `data:text/javascript,${encodeURIComponent(code)}`,
      shortCircuit: true,
    }
  }
  if (specifier === '@google/genai') {
    const code = `
      export const ThinkingLevel = { LOW: 'LOW' };
      export class GoogleGenAI {
        constructor(config) {
          this.config = config;
          this.models = {
            generateContent: async (params) => {
              const mode = globalThis.__STUB_AI_MODE__ || 'success';
              if (mode === 'error') {
                throw new Error('API_CONNECTION_REFUSED: Mocked Google API Failure');
              }
              if (mode === 'timeout') {
                await new Promise((r) => setTimeout(r, 6000));
                return { text: '遅すぎた返信' };
              }
              const reply = globalThis.__STUB_AI_TEXT__ || 'アルゴリズムの計算量は実務でも超重要ですね！';
              return { text: params?.config?.responseMimeType === 'application/json' ? JSON.stringify({reply}) : reply };
            }
          };
        }
      }
    `
    return {
      url: `data:text/javascript,${encodeURIComponent(code)}`,
      shortCircuit: true,
    }
  }
  if (specifier.startsWith('@/')) {
    const ext = specifier.endsWith('.ts') || specifier.endsWith('.js') ? '' : '.ts'
    const resolvedPath = rootHref + specifier.slice(2) + ext
    return nextResolve(resolvedPath, context)
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!specifier.endsWith('.ts') && !specifier.endsWith('.js') && !specifier.endsWith('.mjs')) {
      return nextResolve(specifier + '.ts', context)
    }
  }
  return nextResolve(specifier, context)
}
