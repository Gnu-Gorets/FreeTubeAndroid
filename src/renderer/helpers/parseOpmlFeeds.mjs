import sax from 'sax'

export function parseOpmlFeeds (data) {
  const feeds = []
  const ancestors = []
  const parser = sax.parser(true)
  parser.onopentag = (node) => {
    if (node.name === 'outline' && ancestors.includes('body') && node.attributes.xmlUrl) {
      feeds.push(node.attributes)
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
