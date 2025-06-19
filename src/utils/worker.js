export function createInlineWorker(workerFunction) {
    // 将函数转为字符串，去除函数声明部分，只保留函数体
    const funcStr = workerFunction.toString();
    const workerCode = funcStr.substring(
      funcStr.indexOf('{') + 1,
      funcStr.lastIndexOf('}')
    );
  
    // 创建 Blob 对象
    const blob = new Blob([workerCode], { type: 'application/javascript' });
  
    // 从 Blob 创建 URL
    const workerUrl = URL.createObjectURL(blob);
  
    // 创建 Worker
    return new Worker(workerUrl);
  }