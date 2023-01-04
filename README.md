# ScopedReuqest

高效的前端数据请求处理工具库。

## 什么是 ScopedRequest？

在前端开发中，我们常常需要对后端接口返回的数据进行处理，例如后端返回了错误的数据类型（常常引起前端报错）、对数据进行简单的类型检查、把值的类型进行转化（例如把字符串形式的数值转化为真实的数值）、对数据进行裁剪（去掉无用的字段）等等。在之前，我们常常通过写具体的代码来实现这些逻辑，这导致代码量很大，且维护起来并不容易。ScopedRequest 对这些处理进行了高度封装，同时基于一种[抽象的 DSL 语言](https://www.tangshuang.net/8445.html)，来对接口进行定义，使得我们的数据请求具有类似 GraphQL 一样的描述性质。ScopedRequest 将我们的数据请求限定在我们预期的范围内，这便是 *Scoped* 的含义。

## 安装

```
npm i scopedrequest
```

## 使用

```js
import { ScopedRequest } from 'scopedrequest'

const SearchImages = `
  GET "https://api.thecatapi.com/v1/images/search" -> [
    {
      id
      url
    }
  ]
`

const data = await ScopedRequest.run(SearchImages)
```

上面这段代码中，我们使用一段文本 DSL 描述了我们的某个请求，我们可以把这段文本放在一个独立的地方，需要这个请求时，使用 `ScopedRequest.run` 执行这个请求，并得到我们需要的数据。

## API

### ScopedRequest#run(code:string, params:object, dataList:object[] | null, context:any): Promise<any>

运行查询，返回一个查询结果的 promise。

- code: DSL 代码
- params: 参数，在代码中，你可以使用 `{}` 作为插值，通过 params 传入运行时的真实值，仅在 url 和 headers 中生效
- dataList: 请求体，当发起 POST 或 PUT 请求时需要传入，由于我们在组合语法中并不知道内部会有几个请求需要发送数据，因此，我们必须传入一个数组与需要的请求进行位置上的对应
- context: 自定义透传信息，该信息可在 fetch 配置中被获取

```js
const QueryDetail = `
  GET "http://xxx.com/detail/{id}" -> {
    title
    date
  }
`
// 使用 params -> GET http://xxx.com/detail/123
ScopedRequest.run(QueryDetail, { id: 123 })
```

上面这一句演示了通过插值替换为请求时的真实值。插值设计帮助我们可以把查询代码固化到一个纯文本文件中，而无需和 js 代码混杂在一起。

```js
const AddUser = `
  POST "/api/users" + {
    name
    age
  } -> {
    name
    age
  }
`
ScopedRequest.run(AddUser, null, {
  name: 'tom',
  age: 10,
  // 不会被发送
  height: 12,
})
```

上面这一句演示了发送请求体。ScopedRequest 的一大能力就是对数据进行裁剪，因此不需要的数据不会被作为请求中的部分，在上面的代码中，我们通过 DSL 描述了发送的请求数据只有 `name` 和 `age` 两个字段，因此当我们传入了多个字段时，多余的字段会被裁剪，仅发送真实数据对象中的少数几个字段。另外，此处有一个特殊情况，由于我们的请求中只有一个 `POST` 命令，因此 `run` 的第三个参数可以不传数组，而只传入一个对象（不过如果提交的数据本身是一个数组时，第三个参数必须把提交的数据放在数组内）。

### ScopedRequest#mock(code:string)

当你的后端没有准备好时，你可以基于已有的语法进行数据 mock，获得其结果。此处无需传入params, data等信息，你可以直接将 `run` 替换为 `mock`，从而得到 mock 结果。


```js
ScopedRequest.mock(`
  get "http://xxx.com/{id}" -> {
    name
    age
  }
`).then(data => console.log(data))
```

为了方便和 `run` 保持一致的使用，mock 以 Promise 的形式返回数据。在使用时，你只需要把 `run` 方法替换为 `mock` 方法即可。

另外，你可以传入 `mockers` 这个参数来对不同 shape 进行 mock。传入的 mockers 与 `shapes` 一致。

### ScopedRequest#apply(code:string)

当你需要提供一个最小可使用的数据时，可以使用 `ScopedRequest.apply` 来获得一个最小可用的数据，这个方法在某些需要使用一个默认值时特别有用，例如在 react 中我们常常需要提供一个默认状态，你可以这样：

```js
const DefaultData = ScopedRequest.apply(QuerySomeData)

function SomeComponent() {
  const [data, setData] = useState(DefaultData)
  useEffect(() => {
    ScopedRequest.run(QuerySomeData).then((data) => {
      setData(data)
    })
  }, [])
}
```

`apply` 基于配置中的 `shapes` 作为生成对应格式的默认值，而在生成时相当于没有任何的数据节点，每一个值都会被当作 undefined 进行处理，因此它就能从对应的 shape 函数中得到一个默认值，而通常情况下，这些默认值都是最原始的值，因此，你可以得到一个最小可用的数据。

## 自定义

如果默认的行为无法满足你的需求，你需要通过 new ScopedRequest 来自定义自己的行为。

```js
const request = new ScopedRequest({
  // 覆盖数据请求过程
  async fetch(url, config, data, context) {},
  // 格式器
  shapes: {},
  // 模拟器，和格式器一一对应，返回结果为模拟的结果
  mockers: {},
  // 调试器，当内部认为不正确时，接收一个含有相关信息的对象
  debug(e) {},

  // 是否载入 ScopeX 来进行表达式增强，如果不载入，则只能解析路径，不能执行运算和函数调用
  scopex: null,
  // 向内提供函数，建议函数名全部大写，例如 AVG() SUM()，仅传入 scopex 之后有效，不传入时，调用函数会报错
  fns: {},

  // 同一处理生成好的 url，例如你可以在发出请求前，向 url 末尾添加一个参数
  onCreateUrl(url, { params, url }): string,
  // 生成 url 中的 search 参数时被执行
  // 注意，如果参数提供了 ? ! 则会走内部逻辑，不会在此处被处理
  onCreateParam(key, value, paris: Array<{ key: string, value: any }>): string,
  // 在运行 run 时，向服务端发送数据时，通过 onRequestData 统一对发出的数据进行转换
  onRequestData(data): data,
  // 运行 run 得到数据后，通过 onResponseData 对数据进行统一转换
  onResponseData(data): data,
  // 运行 mock 之后，通过 onMock 进行统一转换
  onMock(data): data,
  // 对于获取到的数据，决定一个本不在 DSL 描述中的属性是否要保留，只对对象有效，
  // 返回 true 表示该属性虽然在 DSL 中没有规定，本来应该被裁剪掉，
  // 但是由于此处返回 true，因此仍然将其保留在返回的结果中
  shouldKeepProperty(key, value, data): boolean,
})
```

传入的参数是自定义的关键。以上参数都是可选的

### fetch

通过什么方式将请求发送到后端接口，并返回数据，是由 fetch 配置项决定的。

- url: 语法解析后得到的 url
- config: 语法解析后得到的参数部分，目前 config 的内容仅为 { headers }
- data: 透传过来的数据，你可以在自己的 fetch 函数中进行 FormData 化
- context: 在运行 query.run 时透传的 context，你可以通过该信息做一些特殊处理

例如在 nodejs 中，你必须传入 fetch 来实现数据请求，否则无法在 nodejs 中运行。

```js
import axios from 'axios'
import { ScopedRequest } from 'scopedrequest'

const request = new ScopedRequest({
  fetch(url, config, data, context) {
    if (config.method.toLowerCase() === 'get') {
      return axios.get(url).then(res => res.data.data)
    }
    // 其他处理...
  },
})

// 使用实例化出来的request
request.run(`
  get "http://xxx.com/xxx" -> {
    name
    age
  }
`).then(data => {
  console.log(data)
})
```

上面的代码演示了我们自定义的一个 request 中定义了自己的 fetch 后的效果，经过定义后，直接返回了后端的 `data` 节点的内容。

### shapes

自定义格式化工具，你需要按照规范传入一系列的函数。

```js
const options = {
  shapes: {
    date: () => (value, keyPath, data) => {
      if (typeof value === 'number') {
        const d = new Date(value)
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate())}`
      }
      return value
    },
  },
}
```

一个 shape 函数的结构如下：

```
(...args:参数) => (this: { debug, command, keyPath }, value:值, keyPath:路径, data:最外层的数据) => 格式化之后的结果
```

第一层 args 表示当你在使用该格式化工具时，在代码中写入的参数，例如：

```
{
  name: date("YY-MM-DD")
}
```

在代码中写入的参数会被传到这里作为 args 使用。

第二层参数 value 代表该位置的值，data 代表最外层的数据，keyPath 表示从 data 上读取 value 的路径。

返回结果将作为格式化后的结果展示。

例如内部的 string, number 都是基于上述的逻辑，对不符合类型的数据进行了转化。

> ScopedRequest 中没有类型的概念，只有 shape 的概念，所以在 DSL 中，我们并不是在规定每个节点的类型，但是我们可以在 shape 函数中进行数据类型的检查，并通过调用 `this.debug` 来抛出错误，从而可以做到一定的类型检查。

## 使用 ScopeX

基于 scopex 你可以在 表达式 语法中实现复杂的表达式和函数：

```js
import { ScopedRequest } from 'scopedrequest'
import { ScopeX } from 'scopex'

const query = new ScopedRequest({
  scopex: ScopeX,
  fns: {
    AVG(args) {
      return args.reduce((total, curr) => total + curr, 0) / args.length
    },
  },
})

query.run(`
  get "..." -> {
    ...
  } as A

  get "..." -> {
    ...
  } as B

  compose -> {
    total: (A.total + B.total); // 使用表达式
    avg: (AVG(A.items.concat(B.items))); // 使用上面定义的函数 AVG()
  }
`)
```

函数使用 `fns` 传入，推荐使用全大写命名。

注意：由于此处调用的函数实际上是表达式的一部分，因此，上面代码中，avg 的内容必须放在一个 `()` 内部，虽然它只执行了函数。

注意：你需要另外安装 scopex，你需要根据你的实际情况来选择是否使用 scopex，避免造成不必要的问题。

## 语言即文档

你可以创建一个 .srl.md 文件来包含多个 request 并且通过 webpack 来实现自动导出。首先，我们创建一个名叫 requests.srl.md 的文件：

```md
\# 接口说明

下面这个部分是整个文档共享部分，可在下方全部接口中使用。
在生成文档/代码时，它实际上会产生多份。

\```
DEFINE SomeData: {
  name
  age
}
\```

\## QueryDetail

这里可以写一些注释，所有的语法被放在 \``` 内部.

\```
GET "..." -> {
  name
  age
}
\```

\## QuerList

\```
GET "..." -> [
  {
    name
    age
  }
]
\```
```

上面这个md文件，可以直接在 markdown 阅读器中进行阅读，可帮助前后端同学一起预览。接下来我们在自己的 js 代码中直接使用这个文件。

```js
import { QueryDetail, QueryList } from './requests.srl.md'
import { ScopedRequest } from 'scopedrequest'

const data = await ScopedRequest.run(QueryDetail, { id: 111 })
```

我们从 .srl.md 中导入了 `##` 后面的名字。*注意，必须是 ## 开头，而非单个 # 开头。*接下来，我们要通过 webpack loader 让这个导入真正可用。

```js
// webpack.config.js

module.exports = {
  module: {
    rules: [
      {
        test: /\.srl\.md$/,
        loader: 'scopedrequest/loader',
        options: {
          // 是否生成/导出ts文件，通过该文件可用于ts代码检查
          // 注意，由于语法上的差异，如果出现大量函数、表达式，将无法得到你想要的ts效果，仅支持较为通用的简单的类型检查
          ts: true,
        },
      },
    ],
  },
}
```

通过加入上面的那个 rule，我们就可以让 .srl.md 文件导出我们需要的内容。

## License

AGPL
