import process from 'node:process'

function cloneToken(token) {
  return { ...token }
}

// Keep the upstream primitive helper local to the compat harness so the new
// repo does not depend on legacy packages/core source layout.
export function alignThemesTokenization(...themes) {
  if (themes.length === 0)
    return []

  const outThemes = themes.map(() => [])
  const count = themes.length

  for (let lineIndex = 0; lineIndex < themes[0].length; lineIndex += 1) {
    const lines = themes.map(theme => theme[lineIndex])
    const outLines = outThemes.map(() => [])
    outThemes.forEach((theme, index) => theme.push(outLines[index]))

    const indexes = lines.map(() => 0)
    const current = lines.map(line => line[0])

    while (current.every(Boolean)) {
      const minLength = Math.min(...current.map(token => token.content.length))

      for (let themeIndex = 0; themeIndex < count; themeIndex += 1) {
        const token = current[themeIndex]
        if (token.content.length === minLength) {
          outLines[themeIndex].push(cloneToken(token))
          indexes[themeIndex] += 1
          current[themeIndex] = lines[themeIndex][indexes[themeIndex]]
        }
        else {
          outLines[themeIndex].push({
            ...token,
            content: token.content.slice(0, minLength),
          })
          current[themeIndex] = {
            ...token,
            content: token.content.slice(minLength),
            offset: token.offset + minLength,
          }
        }
      }
    }
  }

  return outThemes
}

void process
