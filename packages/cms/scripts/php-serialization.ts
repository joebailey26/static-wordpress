export type PhpValue = null | boolean | number | string | PhpValue[] | { [key: string]: PhpValue }

export function unserialize(input: string): PhpValue {
  const bytes = Buffer.from(input, 'utf8'); let cursor = 0
  function token(until: string) {
    const end = bytes.indexOf(until.charCodeAt(0), cursor)
    if (end < 0) throw new Error('Invalid serialized metadata')
    const text = bytes.subarray(cursor, end).toString('utf8'); cursor = end + 1

    return text
  }
  function value(): PhpValue {
    const type = String.fromCharCode(bytes[cursor++])
    if (type === 'N') {
      cursor++

      return null
    }
    if (bytes[cursor++] !== 58) throw new Error('Invalid serialized metadata separator')
    if (['i', 'd', 'b'].includes(type)) {
      const raw = token(';')

      return type === 'b' ? raw === '1' : Number(raw)
    }
    if (type === 's') {
      const length = Number(token(':'))
      if (bytes[cursor++] !== 34 || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid serialized string')
      const text = bytes.subarray(cursor, cursor + length).toString('utf8'); cursor += length
      if (bytes[cursor++] !== 34 || bytes[cursor++] !== 59) throw new Error('Invalid serialized string length')

      return text
    }
    if (type === 'a') {
      const length = Number(token(':'))
      if (bytes[cursor++] !== 123 || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid serialized array')
      const pairs: [PhpValue, PhpValue][] = []
      for (let index = 0; index < length; index++) pairs.push([value(), value()])
      if (bytes[cursor++] !== 125) throw new Error('Invalid serialized array end')

      // Object keys are strings, as Object.fromEntries would make them.
      return pairs.every(([key], index) => key === index) ? pairs.map(([, item]) => item) : Object.fromEntries(pairs.map(([key, item]) => [String(key), item]))
    }
    throw new Error('Unsupported serialized metadata type')
  }

  return value()
}
