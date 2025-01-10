import { isMatch, getStringHash, parseKey, parseValue } from './utils.js'

export const TYPES  = {
  COMMAND: 'Command',
  OBJECT: 'Object',
  ARRAY: 'Array',
  TUPLE: 'Tuple',
  PROP: 'Prop',
  ITEM: 'Item',
  SYMBOL: 'Symbol',
}

// 开始对象/数组、元组
const BeginSigns = {
  '{': TYPES.OBJECT,
  '[': TYPES.ARRAY,
  '<': TYPES.TUPLE,
}

export function tokenize(code) {
  /**
   * 代码内不允许任何字符串主动换行，例如，你不能 -H "a \n b"
   */
  const lines = code.trim().split('\n').map(line => line.trim()).filter(line => line && !/^\/\//.test(line))
  const source = lines.join('\n')

  const program = []
  const stack = [program]

  let quota = ''
  let token = ''
  // let brackets = 0
  let comments = ''

  const commit = () => {
    const str = token.trim()
    if (str) {
      stack[stack.length - 1].push(str)
      token = ''
    }
  }

  for (let i = 0, len = source.length; i < len; i ++) {
    const char = source[i]

    if (char === '') {
      continue
    }

    const next = source[i + 1]
    const prev = source[i - 1]
    const container = stack[stack.length - 1]

    if (char === '(') {
      let at = i
      let prev = source[at - 1]
      while (prev === ' ') {
        prev = source[-- at]
      }
      if (prev === ':') {
        commit()
        let exp = ''
        let brackets = 1
        for (let pos = i + 1; pos < len; pos ++) {
          let char = source[pos]
          if (char === ')') {
            brackets --
            if (brackets === 0) {
              container.push(['(', exp, ')'])
              i = pos + 1
            }
            else {
              exp += char
            }
          }
          else if (char === '\n' && brackets >= 1) {
            throw new Error(`Unexpected newline in expression: ${exp}`)
          }
          else {
            if (char === '(') {
              exp += char
              brackets ++
            }
            else {
              exp += char
            }
          }
        }
        continue
      }
    }

    // if (brackets) {
    //   token += char
    //   if (char === ')') {
    //     brackets --
    //   }
    //   if (!brackets) {
    //     commit()
    //   }
    //   continue
    // }

    // if (char === '(') {
    //   // 千万不要commit，(跟着字符串走
    //   token += char
    //   brackets ++
    //   continue
    // }

    if (comments) {
      comments += char
      if (char + next === '*/') {
        comments += '*/'
        // TODO 对注释进行解析，实现一些类似宏一类的功能，比如可以在注释中加入mock规则
        comments = ''
        i ++
      }
      continue
    }

    if (char + next === '/*') {
      commit()
      comments += '/*'
      i ++
      continue
    }

    if (quota) {
      token += char
      // 转义字符，无论什么情况，都不会结束该引号
      if (prev === '\\') {
        continue
      }
      // 结束一个引号
      if (char === quota) {
        quota = ''
        commit()
      }
      continue
    }

    // 进入一个引号
    if (char === '"' || char === "'" || char === '`') {
      commit()
      token += char
      quota = char
      continue
    }

    if (char === '}' || char === ']' || char === '>' || char === ')') {
      commit()
      container.push(char)
      // 弹出栈
      stack.pop()
      continue
    }

    if (char === '{' || char === '[' || char === '<' || char === '(') {
      commit()
      const block = [char]
      // 推进当前所处的程序中
      container.push(block)
      // 推进栈
      stack.push(block)
      continue
    }

    if (char + next === '->') {
      commit()
      container.push('->')
      // 跳过下一个字符
      i ++
      continue
    }

    if (char === '\n' && prev !== '{' && prev !== '[' && prev !== '[') {
      commit()
      container.push(char)
      continue
    }

    if (char === ';' || char === ':' || char === ',') {
      commit()
      container.push(char)
      continue
    }

    if (char === '+' && container === program) {
      commit()
      container.push('+')
      continue
    }

    if (char === ' ' && container === program) {
      commit()
      continue
    }

    token += char
  }

  if (token) {
    commit()
  }

  return program
}

export function parseStructure(program, deepth = 0) {
  const tokens = program.slice(1, program.length - 1)

  const type = BeginSigns[program[0]]
  const structure = {
    type,
    nodes: [],
    deepth,
  }

  let node = null

  for (let i = 0, len = tokens.length; i < len; i ++) {
    const curr = tokens[i]
    const next = tokens[i + 1]

    const createValue = () => {
      let token = tokens[i]

      let operators = ''
      let name = ''
      let exps = []

      const words = []
      while (token !== ';' && token !== '\n' && token !== ',' && i < tokens.length) {
        words.push(token)
        i ++
        token = tokens[i]
      }
      // 退回到 ; 等结束符，好进入下面等 node = null
      i --

      const [first, second] = words
      // 整个节点
      if (Array.isArray(first) && BeginSigns[first[0]]) {
        const node = parseStructure(first, deepth + 1)
        return node
      }

      if (typeof first === 'string') {
        const [optors, title] = parseValue(first)
        operators = optors
        name = title
      }

      const findExps = (arr) => {
        const flat = (arr) => {
          let str = ''
          arr.forEach((item) => {
            if (Array.isArray(item)) {
              str += flat(item)
            }
            else {
              str += item
            }
          })
          return str
        }
        const inner = arr.slice(1, arr.length - 1)
        const groups = [[]]
        inner.forEach((item) => {
          if (item === ',') {
            groups.push([])
          }
          else {
            groups[groups.length - 1].push(item)
          }
        })
        exps = groups.map(flat)
      }

      if (Array.isArray(first) && first[0] === '(') {
        findExps(first)
      }
      else if (Array.isArray(second) && second[0] === '(') {
        findExps(second)
      }

      return [operators, name, exps]
    }

    if (curr === ';' || curr === '\n' || curr === ',') {
      node = null
      continue
    }

    if (!node) {
      if (type === TYPES.OBJECT) {
        node = {
          type: TYPES.PROP,
          key: parseKey(curr),
        }
        if (next === ':') {
          // 跳过冒号
          i += 2
          node.value = createValue()
        }
      }
      else if (type === TYPES.ARRAY || type === TYPES.TUPLE) {
        node = {
          type: TYPES.ITEM,
        }
        if (next === ':') {
          node.key = parseKey(curr)
          // 跳过冒号
          i += 2
          node.value = createValue()
        }
        else {
          node.value = createValue()
        }
      }
      structure.nodes.push(node)
      continue
    }
  }

  return structure
}

export function parse(tokens) {
  const commands = []

  let command = null

  const substr = (i) => tokens.slice(i - 10, i + 10).join()

  const mapping = {
    // 目前仅支持headers
    H: 'headers',
  }

  for (let i = 0, len = tokens.length; i < len; i ++) {
    const curr = tokens[i]
    const next = tokens[i + 1]
    const prev = tokens[i - 1]

    if (curr === '\n' && prev === '\\') {
      continue
    }

    if (curr === ';' || curr === '\n') {
      // 当且仅当下一个token为字母时才认为进入了新的命令，否则还是当前命令
      if (/^[a-zA-Z][a-zA-Z0-9_]+$/.test(next)) {
        if (command) {
          commands.push(command)
        }
        command = null
      }
      continue
    }

    if (!command) {
      command = {
        type: TYPES.COMMAND,
        command: curr,
      }
    }
    else if (curr === ':') {
      if (Array.isArray(next) && BeginSigns[next[0]]) {
        command.body = parseStructure(next)
        // 跳过下一个
        i ++
      }
      else if (typeof next === 'string') {
        const symbol = next
        const next2 = tokens[i + 2]
        // 是一个函数
        if (Array.isArray(next2) && next2[0] === '(') {
          i ++
          command.body = {
            type: TYPES.SYMBOL,
            value: `${symbol}${next2.join('')}`,
          }
        }
        else {
          command.body = {
            type: TYPES.SYMBOL,
            value: symbol,
          }
        }
        i ++
      }
      else {
        throw new Error(`${curr} at ${substr(i)} 必须给出结构体`)
      }
    }
    else if (curr === '->') {
      if (Array.isArray(next)) {
        command.res = parseStructure(next)
        // 跳过下一个
        i ++
      }
      else if (typeof next === 'string') {
        const symbol = next
        const next2 = tokens[i + 2]
        // 是一个函数
        if (Array.isArray(next2) && next2[0] === '(') {
          i ++
          command.res = {
            type: TYPES.SYMBOL,
            value: `${symbol}${next2.join('')}`,
          }
        }
        else {
          command.res = {
            type: TYPES.SYMBOL,
            value: symbol,
          }
        }
        i ++
      }
      else {
        throw new Error(`${curr} at ${substr(i)} 必须给出结构体`)
      }
    }
    else if (curr === '+') {
      if (Array.isArray(next)) {
        command.req = parseStructure(next)
        // 跳过下一个
        i ++
      }
      else if (typeof next === 'string') {
        const symbol = next
        const next2 = tokens[i + 2]
        // 是一个函数
        if (Array.isArray(next2) && next2[0] === '(') {
          i ++
          command.req = {
            type: TYPES.SYMBOL,
            value: `${symbol}${next2.join('')}`,
          }
        }
        else {
          command.req = {
            type: TYPES.SYMBOL,
            value: symbol,
          }
        }
        i ++
      }
      else {
        throw new Error(`${curr} at ${substr(i)} 必须给出结构体`)
      }
    }
    else if (curr === 'as') {
      command.alias = next
      i ++
    }
    else if (/^-[A-Z]$/.test(curr)) {
      if (!/['"].*?['"]/.test(next)) {
        throw new Error(`${command.command} ${curr} 标记后面必须跟上参数内容`)
      }

      const k = curr[1]
      const name = mapping[k]
      if (name) {
        const options = command.options = command.options || {}
        if (!options[name]) {
          options[name] = {}
        }
        const [key, value] = next.substring(1, next.length - 1).split(':').map(item => item.trim())
        options[name][key] = value
      }
      // 虽然可能并没有该参数，但还是要跳过
      i ++
    }
    else {
      if (!command.args) {
        command.args = []
      }
      if (/^["'].*?["']$/.test(curr)) {
        command.args.push(curr.substring(1, curr.length - 1))
      }
      else {
        command.args.push(curr)
      }
    }
  }

  if (command) {
    commands.push(command)
  }

  const lastItem = commands[commands.length - 1]
  if (lastItem.alias) {
    throw new Error(`905: (${tokens})中最后一条语句不允许使用as语法`)
  }

  return {
    type: 'Program',
    body: commands,
  }
}

const caches = []
export function interpret(code) {
  const parseCode = (code) => {
    const length = code.length
    const summaryLen = 60

    let cache = null
    const filterByLen = caches.filter(item => item.length === length)
    if (filterByLen.length > 1) {
      const summary = code.substring(0, summaryLen) + code.substring(summaryLen * 2, summaryLen)
      const filterBySummary = filterByLen.filter(item => item.summary === summary)
      if (filterBySummary.length > 1) {
        const hash = getStringHash(code)
        const findByHash = filterBySummary.find(item => item.hash === hash)
        if (findByHash) {
          cache = findByHash
        }
      }
    }

    if (!cache) {
      const summary = code.substring(0, summaryLen) + code.substring(summaryLen * 2, summaryLen)
      const hash = getStringHash(code)
      const tokens = tokenize(code)
      const ast = parse(tokens, code)
      caches.push({ hash, summary, ast, length })
      return ast
    }

    return cache.ast
  }

  const ast = parseCode(code.trim())

  const commands = ast.body

  const fragments = {}
  const groups = [[]]
  let groupIndex = 0

  commands.forEach((item) => {
    if (item.type !== TYPES.COMMAND) {
      return
    }

    if (isMatch(item.command, 'fragment') || isMatch(item.command, 'define')) {
      fragments[item.args[0]] = item.body
    }
    else if (isMatch(item.command, 'await')) {
      groups[groupIndex].push(item)
      groupIndex ++
      groups[groupIndex] = []
    }
    else if (isMatch(item.command, 'compose')) {
      groupIndex ++
      groups[groupIndex] = [item]
    }
    else {
      groups[groupIndex].push(item)
    }
  })

  return { groups, fragments, commands, ast }
}
