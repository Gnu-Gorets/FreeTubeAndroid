import sax from 'sax'

export function parseOpmlFeeds (data) {
  try {
    return parseFeeds(data, true)
  } catch {
    // Preserve lenient OPML imports without parsing HTML into DOM.
    return parseFeeds(data, false)
  }
}

function parseFeeds (data, strict) {
  const feeds = []
  const ancestors = []
  const parser = sax.parser(strict, { lowercase: true })
  parser.onopentag = (node) => {
    if (node.name === 'outline' && ancestors.includes('body')) {
      const { xmlurl, ...attributes } = node.attributes
      const xmlUrl = attributes.xmlUrl ?? xmlurl
      if (xmlUrl) feeds.push({ ...attributes, xmlUrl })
    }
    ancestors.push(node.name)
  }
  parser.onclosetag = (name) => {
    ancestors.length = ancestors.lastIndexOf(name)
  }
  parser.onerror = error => { throw error }
  parser.write(data).close()
  return feeds
}
