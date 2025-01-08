import { TYPES, interpret } from './compiler.js'
import { isMatch, sleep, parseFn, tryParse, parseKeyPath } from './utils.js'

const defaultMockers = {
  string: () => () => {
    const CHARS = '0123456789abcdefghigklmnopqrstuvwxyz'
    let text = ''
    for (let i = 0; i < 8; i++) {
      text += CHARS.charAt(Math.floor(Math.random() * CHARS.length))
    }
    return text
  },
  number: () => () => +((Math.random() * 100).toFixed(2)),
  boolean: () => () => [true, false][parseInt((Math.random() * 100 % 2) + '', 10)],
}

const defaultShapes = {
  string: () => function(value) {
    const { debug, target, command, direction, keyPath } = this

    if (typeof value === 'string') {
      return value
    }

    debug?.({
      command,
      url: target,
      keyPath,
      should: 'string',
      receive: value,
      direction,
    })
    return value === null || value === undefined ? '' : '' + value
  },
  number: (defaultValue) => function(value) {
    const { debug, target, command, direction, keyPath } = this

    if (typeof value === 'number' && !Number.isNaN(value)) {
      return value
    }

    if (typeof value === 'string' && !Number.isNaN(+value)) {
      return +value
    }

    debug?.({
      command,
      url: target,
      keyPath,
      should: 'number',
      receive: value,
      direction,
    })
    return +defaultValue || 0
  },
  boolean: () => function(value) {
    const { debug, target, command, direction, keyPath } = this

    if (typeof value === 'boolean') {
      return value
    }

    debug?.({
      command,
      url: target,
      keyPath,
      should: 'boolean',
      receive: value,
      direction,
    })

    // 支持字符串形式的false和0
    if (value === 'false' || value === '0') {
      return false
    }

    return !!value
  },
}

export class RestScript {
  constructor(options = {}) {
    this.options = options
  }

  compile(code) {
    const { ast } = interpret(code)

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

  async run(code, vars = {}, dataList, context) {
    // 保证编译也是异步的，这样可以在catch中捕获错误
    await sleep()

    const { debug } = this.options
    const { groups, fragments, commands } = this.compile(code)

    /**
     * 对dataList做检查和要求
     */
    const postAndPut = commands.filter((item) => item.type === TYPES.COMMAND && item.req)
    if (postAndPut.length) {
      // 在只有一条的情况下，允许提供单个参数，否则必须提供为数组
      if (postAndPut.length === 1 && dataList && !Array.isArray(dataList)) {
        dataList = [dataList]
      }
      else if (!dataList || !Array.isArray(dataList) || dataList.length !== postAndPut.length) {
        throw new Error(`901: run(${code})中dataList必须是包含${postAndPut.length}条数据的数组`)
      }
    }

    // 用于保存alias
    const results = {}

    // 替换参数部分插值和表达式
    const replaceBy = (str, warning) => {
      return str.replace(/\{([a-zA-Z0-9_]+)\}/g, (matched, key) => {
        if (vars && typeof vars[key] !== 'undefined') {
          return vars[key]
        }

        // 必传错误提示
        if (warning && (!vars || typeof vars[key] === 'undefined')) {
          debug?.({
            level: 'error',
            message: `${str} ${key} 必须传入`,
          })
        }

        return matched
      }).replace(/\((.*?)\)/g, (_, expcom) => {
        const exps = expcom.split(',')
        const exp = exps[exps.length - 1]
        const v = this.parse(exp, results)
        return v
      })
    }

    // 对url的search部分特殊处理
    const replaceUrl = (str) => {
      // 此处要注意，url中可能存在多个?，因为我们允许通过 {xxx?} 的参数形式
      const [pathname, ...queries] = str.split('?')
      const search = queries.join('?')
      const path = replaceBy(pathname, true)

      if (!search) {
        return path
      }

      const pairs = search.split('&').map((item) => {
        const [key, value] = item.split('=')

        if (/^\{[a-zA-Z0-9_]+[!?]?\}$/.test(value)) {
          const paramExp = value.substring(1, value.length - 1)
          const [before, after] = paramExp.split(':')
          const end = before[before.length - 1]
          const required = end === '!' // when undefined, give it as empty
          const optional = end === '?' // when undefined, drop the pair

          let paramKey = before
          if (required || optional) {
            paramKey = before.substring(0, before.length - 1)
          }

          const paramValue = vars[paramKey]
          const [fn, args] = after ? parseFn(after) : []
          const content = fn ? this.format(paramValue, fn, (args || []).map(tryParse), { ...context, keyPath: ['@' + paramKey] }) : vars[paramKey]

          // 如果不存在该传入的params，就直接跳过该param，不在url中使用这个query
          if (typeof content === 'undefined') {
            // optional, drop the key
            if (optional) {
              return
            }
            // 强制给参数，即使为空
            if (required) {
              return { key, value: '' }
            }
            if (!optional) {
              debug?.({
                level: 'error',
                message: `${str} ${paramKey} 必须传入`,
              })
            }
          }

          return { key, value: content }
        }

        return { key, value }
      }).filter(Boolean)


      if (!pairs.length) {
        return path
      }

      const searchParams = pairs.map(({ key, value }) => {
        const output = this.options.onCreateParam ? this.options.onCreateParam(key, value, pairs) : `${key}=${value}`
        return output
      })

      return path + '?' + searchParams.join('&')
    }

    const allFetchings = []

    const fn = async (node, index = -1) => {
      const { args = [], options = {}, alias, command, req, res } = node
      const [url] = args

      if (!url) {
        throw new Error(`800: run(${code})中 ${command} 没有给url`)
      }

      const { headers = {} } = options

      const replacedUrl = replaceUrl(url)
      const realUrl = this.options.onCreateUrl ? this.options.onCreateUrl(replacedUrl, { vars, url }) : replacedUrl
      const realHeaders = Object.keys(headers).reduce((obj, key) => {
        obj[key] = replaceBy(headers[key], true)
        return obj
      }, {})

      let realData = null
      const postData = index > -1 ? dataList[index] : null

      if (this.options.onSetup) {
        await this.options.onSetup({
          method: command,
          url: realUrl,
          headers: realHeaders,
          data: postData,
          node,
          req,
          res,
          alias,
          vars,
        });
      }


      if (req && postData) {
        realData = this.generate(
          {
            structure: req,
            data: postData,
            fragments,
            results,
          },
          {
            command,
            url,
            alias,
            req,
            target: realUrl,
            root: postData,
            use: 'req',
            keyPath: [],
            direction: 'request',
          },
        )
      }

      let finalPostData = realData;
      if (this.options.onRequest) {
        finalPostData = await this.options.onRequest(realData, {
          method: command,
          url: realUrl,
          headers: realHeaders,
          data: postData,
          node,
          req,
          res,
          alias,
          vars,
        })
      }

      const data = await this.fetch(realUrl, { method: command, headers: realHeaders }, finalPostData, context)

      let output = null
      if (res) {
        output = this.generate(
          {
            structure: res,
            data,
            fragments,
            results,
          },
          {
            command,
            url,
            alias,
            res,
            target: realUrl,
            root: data,
            use: 'res',
            keyPath: [],
            direction: 'response',
          },
        )
      }

      allFetchings[index] = {
        method: command,
        url: realUrl,
        headers: realHeaders,
        payload: finalPostData,
        data,
        node,
      }

      if (this.options.onResponse) {
        output = await this.options.onResponse(output, {
          method: command,
          url: realUrl,
          headers: realHeaders,
          source: postData,
          input: realData,
          payload: finalPostData,
          data,
          node,
          req,
          res,
          alias,
          vars,
        });
      }

      return output
    }

    const compose = (node) => {
      const { command, alias, res } = node
      return this.generate(
        {
          structure: res,
          fragments,
          results,
        },
        {
          command,
          alias,
          res,
          use: 'res',
          keyPath: [],
          direction: 'response',
        },
      )
    }

    return await new Promise((resolve, reject) => {
      let i = 0
      let meet = 0
      let isCompelet = false

      const allRequests = []

      const through = () => {
        const group = groups[i]
        if (!group || isCompelet) {
          return
        }
        return new Promise((next) => {
          const awaitItem = group.find(item => item.type === TYPES.COMMAND && isMatch(item.command, 'await'))
          const awaitNames = awaitItem ? awaitItem.args : []

          const awaitRequests = []
          const groupRequests = []

          group.forEach((item, n) => {
            const { alias, command, req } = item

            if (isMatch(command, 'await')) {
              // 一般 await 不允许是最后一条语句，这里做一个兜底
              if (isFinal) {
                resolve()
                isCompelet = true
              }
              return
            }

            // 最后一条输出命令
            const isFinal = i === groups.length - 1 && n === group.length - 1

            if (isMatch(command, 'compose')) {
              // compose 自带 await 功能，要等之前的请求回来之后再执行 compose
              // compose 只能使用之前已经定义了的alias
              Promise.all([...allRequests]).then(() => {
                const data = compose(item)
                if (alias) {
                  results[alias] = data
                }
                if (isFinal) {
                  resolve(data)
                  isCompelet = true
                }
              }).catch(reject)
              return
            }

            let index = -1
            if (req) {
              index = meet
              meet ++
            }
            const p = fn(item, index).then((data) => {
              if (alias) {
                results[alias] = data
              }
              if (isFinal) {
                resolve(data)
                isCompelet = true
              }
            })

            allRequests.push(p)
            groupRequests.push(p)
            if (awaitNames.includes(alias)) {
              awaitRequests.push(p)
            }
          })

          const goNext = () => {
            i ++
            next()
          }
          if (awaitRequests.length) {
            // 接住任何错误
            Promise.all(groupRequests.filter(p => !awaitRequests.includes(p))).catch(reject)
            // await 总是 group 的最后一条，所以到此，group 所有请求已发出，但是需要等待所有 await 子句结束才能进入下一个 group
            Promise.all(awaitRequests).then(goNext).catch(reject)
          }
          else {
            // 接住任何错误
            Promise.all(groupRequests).catch(reject)
            // 全部都是异步的，不需要像 awaitRequests 一样等待，直接进入下一步即可
            goNext()
          }
        }).then(through).catch(reject)
      }
      through()
    }).then((data) => {
      if (this.options.onSuccess) {
        return this.options.onSuccess(data, { code, vars, context, requests: allFetchings })
      }
      return data
    }, (err) => {
      if (this.options.onError) {
        const error = this.options.onError(err, { code, vars, context, requests: allFetchings })
        return Promise.resolve(error)
      }
      return Promise.reject(err)
    })
  }

  parse(exp, data) {
    const { scopex, debug, fns = {} } = this.options

    if (scopex) {
      const scope = new scopex({ ...data, ...fns })
      return scope.parse(exp)
    }

    if (/^[a-zA-Z]+(\.?|$)/.test(exp)) {
      const chain = exp.split('.')
      let curr = data
      for (let i = 0, len = chain.length; i < len; i ++) {
        const key = chain[i]
        if (curr && typeof curr === 'object') {
          curr = curr[key]
        }
        else {
          return
        }
      }
      return curr
    }

    try {
      exp = exp.replace(/'/g, '"').replace(/(\w+):/g, '"$1":')
      return JSON.parse(exp)
    }
    catch (e) {
      debug?.({
        message: `表达式无法解析：${exp}`,
        level: 'debug',
      })
      return exp
    }
  }

  async fetch(url, config = {}, data, context) {
    if (this.options.fetch) {
      return await this.options.fetch(url, config, data, context)
    }
    const { method } = config
    const options = { ...config }
    if (data && typeof data === 'object' && !(data instanceof FormData) && isMatch(method, 'post', 'put', 'patch')) {
      // 避免content-type没有传
      options.headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      }
      options.body = JSON.stringify(data)
    }
    else if (data) {
      options.body = data
    }
    // eslint-disable-next-line no-undef
    const res = await fetch(url, options)
    return await res.json()
  }

  /**
   *
   * @param {*} node
   * @param {*} data 需要传入对应的完整数据，如数组，对象，而非当前这个节点的值
   * @param {*} params
   * @param {number} [params.index] 当对数组或元组元素进行处理时，必须传入，否则不要传入
   * @returns
   */
  create(node, data, { fragments, results, context, index }) {
    const { debug } = this.options
    const { keyPath = [], command, target, alias, direction } = context

    const { key: keyInfo, value: valueInfo } = node
    const [name, decorators] = keyInfo || []

    const key = name || index
    // 对应的后端字段名
    const [, field = key] = decorators?.match(/~(\w+)/) || []
    const value = data[field]

    const output = {
      key,
    }

    if (node.type === TYPES.ITEM) {
      if (typeof index === 'undefined') {
        debug?.({
          command,
          url: target,
          keyPath,
          alias,
          message: `结构体中的${keyPath.join('.')}没有传入index，请检查`,
          level: 'error',
          direction,
        })
      }

      const isFilterRule = /^['"].*?['"]$/.test(decorators || '')
      if (typeof index !== 'undefined' && typeof name !== 'undefined' && +name !== +index && !isFilterRule) {
        debug?.({
          command,
          url: target,
          keyPath,
          alias,
          message: `结构体中的${keyPath.join('.')}.${name}与传入的 ${index} 不匹配，请检查`,
          level: 'debug',
          direction,
        })
      }

      // 没有具体的key，就使用push
      if (isFilterRule) {
        output.key = undefined
      }
    }

    // 允许为null或undefined，如果这两种情况，将被设定为null
    if ((value === null || typeof value === 'undefined') && decorators?.indexOf('??') > -1) {
      output.value = null
      return output
    }

    // 允许字段不存在
    if (typeof value === 'undefined' && decorators?.indexOf('?') > -1) {
      return
    }

    const currContext = {
      ...context,
      keyPath: [...keyPath, key],
      debug,
    }

    const transfer = (decorators, data, structure) => {
      // 通过!做强制转换
      if (decorators?.indexOf('!') > -1) {
        if ((structure.type === TYPES.ARRAY || structure.type === TYPES.TUPLE) && !Array.isArray(data)) {
          return [data]
        }
        else if (structure.type === TYPES.OBJECT && Array.isArray(data) && data[0] && typeof data[0] === 'object') {
          return data[0]
        }
        else if (structure.type === TYPES.ARRAY || structure.type === TYPES.TUPLE) {
          return []
        }
        else if (structure.type === TYPES.OBJECT) {
          return {}
        }
      }
      return data
    }

    // 没有值描述
    if (!valueInfo) {
      output.value = value
      return output
    }

    // 值是常规描述
    if (Array.isArray(valueInfo)) {
      const [operators, tag, exps = []] = valueInfo
      if (tag && operators === '&') {
        const fragment = fragments[tag]
        if (!fragment) {
          throw new Error(`${tag} Fragment at ${keyPath.join('.')}.${key} 不存在，请检查`)
        }

        const useData = transfer(decorators, value, fragment)

        const out = this.generate({
          structure: fragment,
          data: useData,
          fragments,
          results,
        }, currContext)

        output.value = out
        return output
      }
      else if (tag) {
        const out = this.format(value, tag, exps.map(exp => this.parse(exp, results)), currContext)
        output.value = out
        return output
      }
      else if (exps.length) {
        const out = this.parse(exps[exps.length - 1], results)
        output.value = out
        return output
      }
      else {
        throw new Error(`格式 ${valueInfo.join(' ')} at ${keyPath.join('.')}.${key} 无法别识别`)
      }
    }

    // 值是对象描述
    if (valueInfo && typeof valueInfo === 'object') {
      const useData = transfer(decorators, value, valueInfo)
      const out = this.generate({
        structure: valueInfo,
        data: useData,
        fragments,
        results,
      }, currContext)
      output.value = out
      return output
    }
  }

  generate(information, context) {
    // compose中没有传data
    const { structure, results, fragments } = information
    const { keyPath = [], command, target, alias, direction } = context
    const { debug } = this.options

    let data = information.data

    /**
     * 构建对象
     */
    if (structure.type === TYPES.OBJECT) {
      if (typeof data !== 'object' || !data) {
        debug?.({
          command,
          url: target,
          keyPath,
          alias,
          should: 'object',
          receive: data,
          direction,
        })
        // 确保数据能被造出来，因为有些格式器可以凭空生成数据
        data = {}
      }

      if (!structure.nodes.length) {
        return data;
      }

      const output = {}
      structure.nodes.forEach((node) => {
        const gened = this.create(node, data, { fragments, results, context })
        if (gened) {
          const { key, value } = gened
          output[key] = value
        }
      })

      if (this.options.shouldKeepProperty) {
        const keys = Object.keys(data)
        keys.forEach((key) => {
          const value = data[key]
          if (this.options.shouldKeepProperty(key, value, data)) {
            output[key] = value
          }
        })
      }

      return output
    }

    /**
     * 构建数组
     */
    if (structure.type === TYPES.ARRAY) {
      if (!Array.isArray(data)) {
        // array like的对象，有的时候后端发送的数组实际上变成了对象，如 { 0: ..., 1: ..., 2: ... }，此时我们要把它转化为数组
        if (data && typeof data === 'object' && Object.keys(data).every(key => /^\d+$/.test(key))) {
          const keys = Object.keys(data)
          data = []
          keys.forEach((key) => {
            const value = data[key]
            data[key] = value
          })
          debug?.({
            command,
            url: target,
            keyPath,
            alias,
            should: 'array',
            receive: data,
            message: '将ArrayLike的对象转化为数组',
            level: 'warn',
            direction,
          })
        }
        else {
          debug?.({
            command,
            url: target,
            keyPath,
            alias,
            should: 'array',
            receive: data,
            direction,
          })
          // 数组可以为空
          return []
        }
      }

      const { nodes } = structure

      // 给了一个空数组
      // 表示这个属性必须是一个数组，但无需检查内部结构，直接返回数据
      if (!nodes.length) {
        return data
      }

      const output = []
      data.forEach((value, index) => {
        // 从多个里面找出当前值最接近的那一个
        let node = this.choose(nodes, value, index, fragments)

        // 如果值是对象，完全没有找到和它形状相似的，就直接丢掉
        if (value && typeof value === 'object' && typeof node === 'undefined') {
          return
        }

        // 没有找到相似的，用第一个凑合
        if (typeof node === 'undefined') {
          node = nodes[0]
        }

        const gened = this.create(node, data, { fragments, results, context, index })
        if (gened) {
          const { key, value } = gened
          if (typeof key === 'undefined') {
            output.push(value)
          }
          else {
            output[key] = value
          }
        }
      })

      return output
    }

    /**
     * 构建元组
     */
    if (structure.type === TYPES.TUPLE) {
      if (!Array.isArray(data)) {
        // array like的对象，有的时候后端发送的数组实际上变成了对象，如 { 0: ..., 1: ..., 2: ... }，此时我们要把它转化为数组
        if (data && typeof data === 'object' && Object.keys(data).every(key => /^\d+$/.test(key))) {
          const keys = Object.keys(data)
          data = []
          keys.forEach((key) => {
            const value = data[key]
            data[key] = value
          })
          debug?.({
            command,
            url: target,
            keyPath,
            alias,
            should: 'tuple',
            receive: data,
            message: '将ArrayLike的对象转化为数组',
            level: 'warn',
            direction,
          })
        }
        else {
          debug?.({
            command,
            url: target,
            keyPath,
            alias,
            should: 'tuple',
            receive: data,
            direction,
          })
          // 将数据重置为空对象，这样可以最终生成比较完整的数据
          data = []
        }
      }

      const output = []
      const { nodes } = structure

      if (data.length !== nodes.length) {
        debug?.({
          command,
          url: target,
          keyPath,
          alias,
          should: 'tuple',
          shouldLength: nodes.length,
          receive: data,
          direction,
        })
        // 调整数据长度，以适应元组长度
        data = data.slice(0, nodes.length)
      }

      nodes.forEach((node, index) => {
        const gened = this.create(node, data, { fragments, results, context, index })
        if (gened) {
          const { key, value } = gened
          output[key] = value
        }
      })
      return output
    }

    if (structure.type === TYPES.SYMBOL) {
      const [name, params] = parseFn(structure.value);
      const output = this.format(data, name, (params || []).map(tryParse), context)
      return output
    }
  }

  choose(items, value, index, fragments) {
    const compares = {
      '=': (a, b) => {
        return a === b
      },
      '>=': (a, b) => {
        return a >= b
      },
      '<=': (a, b) => {
        return a <= b
      },
      '<': (a, b) => {
        return a < b
      },
      '>': (a, b) => {
        return a > b
      },
    };
    const compareBy = (exp) => {
      if (value === null || typeof value !== 'object') {
        return false
      }
      const { key, value: vstr } = exp;
      const compareFn = compares[exp.compare];
      const wantValue = tryParse(vstr);
      const realValue = parseKeyPath(value, key)
      return compareFn(realValue, wantValue)
    };
    // 如果给的数组中，存在 `2: string` 这种，直接把这个作为当前 index 元素的类型，而不是去进行匹配
    const indexMatchedNode = items.find((node) => {
      const { key: keyInfo } = node
      const [name, filter] = keyInfo || []

      if (/^['"].*?['"]$/.test(filter)) {
        const expstr = filter.substring(1, filter.length - 1);
        const exps = expstr.split('&').map((item) => {
          const [, key, compare, value] = item.match(/^(.*?)(>=|<=|=|>|<)(.*?)$/);
          if (!key || !compares[compare]) {
            return;
          }
          return { key, compare, value }
        }).filter(Boolean)
        for (let i = 0, len = exps.length; i < len; i ++) {
          const exp = exps[i]
          if (!compareBy(exp)) {
            return false
          }
        }
        return true
      }

      if (typeof name !== 'undefined' && +name === +index) {
        return true
      }

      return false
    })

    if (indexMatchedNode) {
      return indexMatchedNode
    }

    const { debug } = this.options

    const filtered = items.filter((item) => {
      const { key: keyInfo } = item
      const [name, filter] = keyInfo || []
      // 过滤掉有具体索引号的
      if (typeof name !== 'undefined' || /^['"].*?['"]$/.test(filter)) {
        return false
      }
      return true
    })

    // if there is no normal items rules, the list item will be droped
    if (!filtered.length) {
      return
    }

    const nodes = filtered.map((item) => {
      // 展开fragment来进行比较
      if (Array.isArray(item.value) && typeof item.value[0] === 'string' && item.value[0] === '&') {
        const [, frag] = item.value
        const value = fragments[frag]
        if (!value) {
          debug?.({
            message: `Fragment ${frag} 没有被定义`,
            level: 'warn',
          })
          return item
        }
        return {
          ...item,
          value,
        }
      }
      return item
    })

    /**
     * 传进来的值是数组，那么去找列表中应该是数组的item
     */
    if (Array.isArray(value)) {
      const subItems = nodes.filter(item => item && (item.value?.type === TYPES.ARRAY || item.value?.type === TYPES.TUPLE))
      if (!subItems.length) {
        return
      }

      const getType = (desc) => {
        if (desc?.type === TYPES.OBJECT) {
          return 'object'
        }
        if (desc?.type === TYPES.ARRAY || desc?.type === TYPES.TUPLE) {
          return 'array'
        }
        if (desc?.type === TYPES.PROP || desc?.type === TYPES.ITEM) {
          return desc?.value?.[1]
        }
      }

      // TODO choose real item, now not support sub-array
      // [[string, number], [string, boolean]]
      const typesOfData = value.map(v => Array.isArray(v) ? 'array' : typeof v)
      const scores = subItems.map((item) => {
        const sub = item.value
        if (sub.type === TYPES.TUPLE) {
          const subDescs = sub.nodes
          let score = 0
          for (let i = 0, len = value.length; i < len; i ++) {
            const desc = subDescs[i]
            const descType = desc ? getType(desc.value) : NaN
            const dataType = typesOfData[i]
            score += descType === dataType ? 1 : 0
          }
          return score
        }
        else {
          const subDescs = sub.nodes
          let score = 0
          for (let i = 0, len = value.length; i < len; i ++) {
            const dataType = typesOfData[i]
            score += subDescs.some(desc => dataType === getType(desc)) ? 1 : 0
          }
          return score
        }
      })

      const highest = scores.reduce((info, score, index) => {
        if (info.score < score) {
          info.score = score
          info.index = index
        }
        return info
      }, {
        score: 0,
        index: 0,
      })

      const { index } = highest
      return subItems[index]
    }

    if (value && typeof value === 'object') {
      const subItems = nodes.filter(item => item && item.value?.type === TYPES.OBJECT)
      if (!subItems.length) {
        return
      }

      const keysOfData = Object.keys(value).reduce((keys, key) => {
        keys[key] = 1
        return keys
      }, {})

      const scores = subItems.map((item) => {
        const sub = item.value
        return sub.nodes.reduce((total, node) => {
          const { key: keyInfo } = node
          const [name] = keyInfo || []
          if (keysOfData[name]) {
            total ++
          }
          return total
        }, 0)
      }, {})

      const highest = scores.reduce((info, score, index) => {
        if (info.score < score) {
          info.score = score
          info.index = index
        }
        return info
      }, {
        score: 0,
        index: 0,
      })

      const { index } = highest
      return subItems[index]
    }
  }

  format(value, fn, args, context) {
    const { shapes = {} } = this.options
    const allShapes = {
      ...defaultShapes,
      ...shapes,
    }
    const { command, url, alias, keyPath, root } = context
    const format = allShapes[fn]

    if (!format) {
      throw new Error(`10009: 未定义${fn}格式 at ${command} ${url} ${alias} ${keyPath.join('.')}`)
    }

    return format(...args).call(context, value, keyPath, root)
  }

  async mock(code) {
    await sleep()

    const { fragments, groups } = interpret(code)
    const { mockers = {}, debug } = this.options

    const results = {}

    const allMockers = {
      ...defaultMockers,
      ...mockers,
    }
    const willExist = () => parseInt((Math.random() * 100 % 2) + '', 10)
    const breakFragment = (keyPath) => {
      if (keyPath.length > 10) {
        debug?.({
          message: `深度大于10 ${keyPath.join('.')} 被强制阻断`,
          level: 'warn',
        })
        return true
      }
    }
    const fn = (structure, context = {}) => {
      const { keyPath = [] } = context

      /**
       * 模拟对象
       */
      if (structure.type === TYPES.OBJECT) {
        const output = {}
        structure.nodes.forEach((prop) => {
          const { key: keyInfo, value: valueInfo } = prop
          const [key, decorators] = keyInfo || []

          const isOptional = decorators?.indexOf('?') > -1
          if (isOptional && !willExist()) {
            return
          }

          const currContext = {
            debug,
            ...context,
            keyPath: [...keyPath, key],
          }

          // 没有给值
          if (!valueInfo) {
            output[key] = allMockers.string()()
          }
          else if (Array.isArray(valueInfo)) {
            const [operators, tag, exps = []] = valueInfo
            if (tag && operators === '&') {
              const fragment = fragments[tag]
              if (!fragment) {
                throw new Error(`${tag} Fragment at ${keyPath.join('.')}.${key} 不存在，请检查`)
              }

              if (breakFragment(keyPath)) {
                return
              }

              const out = fn(fragment, currContext)
              output[key] = out
            }
            else if (tag && operators === '=') {
              output[key] = results[tag]
            }
            else if (tag) {
              const mockfn = allMockers[tag]
              if (!mockfn) {
                throw new Error(`10011: mock(${code})中 ${keyPath.join('.')}.${key} 不存在${tag}这个Mocker`)
              }
              output[key] = mockfn(...exps.map(exp => this.parse(exp, results))).call(currContext)
            }
            else {
              throw new Error(`${keyPath.join('.')}.${key} 无法被mock，因为没有找到合适的mocker`)
            }
          }
          else if (valueInfo && typeof valueInfo === 'object') {
            const out = fn(valueInfo, currContext)
            output[key] = out
          }
        })
        return output
      }

      /**
       * 模拟数组
       */
      if (structure.type === TYPES.ARRAY) {
        const output = []
        const { nodes } = structure
        for (let i = 0, len = Math.floor(Math.random() * 10); i < len; i ++) {
          if (!willExist()) {
            continue
          }

          const len = nodes.length
          const index = parseInt((Math.random() * 10) + '', 10) % len
          const item = nodes[index]

          const { key: keyInfo, value: valueInfo } = item

          const [key, decorators] = keyInfo || []

          if (decorators?.indexOf('?') > -1 && !willExist()) {
            return
          }

          const currContext = {
            ...context,
            keyPath: [...keyPath, key],
            debug,
          }

          if (Array.isArray(valueInfo)) {
            const [operators, tag, exps = []] = valueInfo
            if (tag && operators === '&') {
              const fragment = fragments[tag]
              if (!fragment) {
                throw new Error(`${tag} Fragment at ${keyPath.join('.')}.${key} 不存在，请检查`)
              }

              if (breakFragment(keyPath)) {
                return
              }

              const out = fn(fragment, currContext)
              output.push(out)
            }
            else if (tag && operators === '=') {
              output.push(results[tag])
            }
            else if (tag) {
              const mockfn = allMockers[tag]
              if (!mockfn) {
                throw new Error(`10011: mock(${code})中 ${keyPath.join('.')}.${key} 不存在${tag}这个Mocker`)
              }
              const out = mockfn(...exps.map(exp => this.parse(exp, results))).call(currContext)
              output.push(out)
            }
            else {
              throw new Error(`${keyPath.join('.')}.${key} 无法被mock，因为没有找到合适的mocker`)
            }
          }
          else if (valueInfo && typeof valueInfo === 'object') {
            const out = fn(valueInfo, currContext)
            output.push(out)
          }
        }

        return output
      }

      /**
       * 模拟元组
       */
      if (structure.type === TYPES.TUPLE) {
        const output = []
        const { nodes } = structure

        nodes.forEach((item, index) => {
          const { key: keyInfo, value: valueInfo } = item
          const [key, decorators] = keyInfo || []

          if (decorators?.indexOf('?') > -1 && !willExist()) {
            return
          }

          const currContext = {
            debug,
            ...context,
            keyPath: [...keyPath, key],
          }

          if (Array.isArray(valueInfo)) {
            const [operators, tag, exps = []] = valueInfo || []
            if (tag && operators === '&') {
              const fragment = fragments[tag]
              if (!fragment) {
                throw new Error(`${tag} Fragment at ${keyPath.join('.')}.${key} 不存在，请检查`)
              }

              if (breakFragment(keyPath)) {
                return
              }

              const out = fn(fragment, currContext)
              output[index] = out
            }
            else if (tag) {
              const mockfn = allMockers[tag]
              if (!mockfn) {
                throw new Error(`10011: mock(${code})中 ${keyPath.join('.')}.${key} 不存在${tag}这个Mocker`)
              }
              const out = mockfn(...exps.map(exp => this.parse(exp, results))).call(currContext)
              output[index] = out
            }
            else {
              throw new Error(`${keyPath.join('.')}.${key} 无法被mock，因为没有找到合适的mocker`)
            }
          }
          else if (valueInfo && typeof valueInfo === 'object') {
            const out = fn(valueInfo, currContext)
            output[index] = out
          }
        })
        return output
      }
    }

    let final = null
    groups.forEach((group, i) => {
      group.forEach((item, n) => {
        const isFinal = i === groups.length - 1 && n === group.length - 1
        const { alias, res, args, command } = item

        if (!res) {
          return
        }

        const target = isMatch(command, 'get') ? args[0] : ''
        const data = fn(res, { command: '[mock]', target, debug: null })

        if (alias) {
          results[alias] = data
        }

        if (isFinal) {
          final = data
        }
      })
    })

    if (this.options.onMock) {
      return this.options.onMock(final, { code })
    }

    return final
  }

  apply(code) {
    const { fragments, groups } = interpret(code)
    const { shapes, debug } = this.options

    const results = {}

    const allShapes = {
      ...defaultShapes,
      ...shapes,
    }
    const breakFragment = (keyPath) => {
      if (keyPath.length > 10) {
        debug?.({
          message: `70014: 深度大于10 ${keyPath.join('.')} 被强制阻断`,
          level: 'warn',
        })
        return true
      }
    }
    const fn = (structure, context = {}) => {
      const { keyPath = [] } = context

      /**
       * 模拟对象
       */
      if (structure.type === TYPES.OBJECT) {
        const output = {}
        structure.nodes.forEach((prop) => {
          const { key: keyInfo, value: valueInfo } = prop
          const [key, decorators] = keyInfo || []

          const isOptional = decorators?.indexOf('?') > -1
          if (isOptional) {
            return
          }

          const currContext = {
            debug,
            ...context,
            keyPath: [...keyPath, key],
          }

          // 没有给值
          if (!valueInfo) {
            output[key] = allShapes.string()()
          }
          else if (Array.isArray(valueInfo)) {
            const [operators, tag, exps = []] = valueInfo
            if (tag && operators === '&') {
              const fragment = fragments[tag]
              if (!fragment) {
                throw new Error(`70010: ${tag} Fragment at ${keyPath.join('.')}.${key} 不存在，请检查`)
              }

              if (breakFragment(keyPath)) {
                return
              }

              const out = fn(fragment, currContext)
              output[key] = out
            }
            else if (tag && operators === '=') {
              output[key] = results[tag]
            }
            else if (tag) {
              const create = allShapes[tag]
              if (!create) {
                throw new Error(`70011: ${code} 中 ${keyPath.join('.')}.${key} 不存在${tag}这个Shape`)
              }
              output[key] = create(...exps.map(exp => this.parse(exp, results))).call(currContext)
            }
            else {
              throw new Error(`70012: ${keyPath.join('.')}.${key} 无法被创建，因为没有找到合适的Shape`)
            }
          }
          else if (valueInfo && typeof valueInfo === 'object') {
            const out = fn(valueInfo, currContext)
            output[key] = out
          }
        })
        return output
      }

      /**
       * 模拟数组
       */
      if (structure.type === TYPES.ARRAY) {
        return []
      }

      /**
       * 模拟元组
       */
      if (structure.type === TYPES.TUPLE) {
        const output = []
        const { nodes } = structure

        nodes.forEach((item, index) => {
          const { key: keyInfo, value: valueInfo } = item
          const [key, decorators] = keyInfo || []

          if (decorators?.indexOf('?') > -1) {
            return
          }

          const currContext = {
            debug,
            ...context,
            keyPath: [...keyPath, key],
          }

          if (Array.isArray(valueInfo)) {
            const [operators, tag, exps = []] = valueInfo || []
            if (tag && operators === '&') {
              const fragment = fragments[tag]
              if (!fragment) {
                throw new Error(`70013: ${tag} Fragment at ${keyPath.join('.')}.${key} 不存在，请检查`)
              }

              if (breakFragment(keyPath)) {
                return
              }

              const out = fn(fragment, currContext)
              output[index] = out
            }
            else if (tag) {
              const mockfn = allShapes[tag]
              if (!mockfn) {
                throw new Error(`70014: ${code} 中 ${keyPath.join('.')}.${key} 不存在${tag}这个Shape`)
              }
              const out = mockfn(...exps.map(exp => this.parse(exp, results))).call(currContext)
              output[index] = out
            }
            else {
              throw new Error(`70015: ${keyPath.join('.')}.${key} 无法被创建，因为没有找到合适的Shape`)
            }
          }
          else if (valueInfo && typeof valueInfo === 'object') {
            const out = fn(valueInfo, currContext)
            output[index] = out
          }
        })
        return output
      }
    }

    let final = null
    groups.forEach((group, i) => {
      group.forEach((item, n) => {
        const isFinal = i === groups.length - 1 && n === group.length - 1
        const { alias, res, args, command } = item

        if (!res) {
          return
        }

        const target = isMatch(command, 'get') ? args[0] : ''
        const data = fn(res, { command: '[apply]', target, debug: null })

        if (alias) {
          results[alias] = data
        }

        if (isFinal) {
          final = data
        }
      })
    })

    return final
  }

  static run(code, vars, dataList, context) {
    const ins = new this()
    return ins.run(code, vars, dataList, context)
  }

  static mock(code) {
    const ins = new this()
    return ins.mock(code)
  }

  static apply(code) {
    const ins = new this()
    return ins.apply(code)
  }
}
