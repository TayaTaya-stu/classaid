import crypto from 'crypto'

const ANIMAL_NAMES = [
  'ペンギン', 'ラッコ', 'コアラ', 'イルカ', 'キリン',
  'パンダ', 'リス', 'シカ', 'キツネ', 'クマ',
  'ウサギ', 'フクロウ', 'カワウソ', 'ハムスター', 'アザラシ',
  'トラ', 'ライオン', 'カンガルー', 'ウォンバット', 'タヌキ',
  'ハリネズミ', 'アルパカ', 'モモンガ', 'ヒツジ', 'ヤギ',
  'チーター', 'レッサーパンダ', 'フェネック', 'カピバラ', 'ビーバー'
]

/**
 * ルーム内で重複しないユニークな短い仮名を生成する
 * @param existingNames そのルームですでに使用されている表示名一覧
 */
export function generateUniqueDisplayName(existingNames: string[]): string {
  const existingSet = new Set(existingNames)

  // 1. まず 1〜50 の範囲でランダムに組み合わせを探す
  for (let attempt = 0; attempt < 200; attempt++) {
    const animalIndex = crypto.randomInt(0, ANIMAL_NAMES.length)
    const number = crypto.randomInt(1, 51)
    const candidate = `${ANIMAL_NAMES[animalIndex]}${number}号`

    if (!existingSet.has(candidate)) {
      return candidate
    }
  }

  // 2. 衝突が多い場合は 51〜999 の範囲で探索
  for (let attempt = 0; attempt < 500; attempt++) {
    const animalIndex = crypto.randomInt(0, ANIMAL_NAMES.length)
    const number = crypto.randomInt(51, 1000)
    const candidate = `${ANIMAL_NAMES[animalIndex]}${number}号`

    if (!existingSet.has(candidate)) {
      return candidate
    }
  }

  // 3. 万一すべて衝突した場合のフォールバック
  return `学生${crypto.randomInt(1000, 9999)}`
}
