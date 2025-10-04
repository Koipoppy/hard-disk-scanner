const express = require('express');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const os = require('os');
const child_process = require('child_process');

const app = express();
const PORT = 3000;

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// API接口：获取系统驱动器列表
app.get('/api/drives', (req, res) => {
    try {
        let drives = [];
        
        if (os.platform() === 'win32') {
            try {
                // Windows系统获取驱动器 - 主要方法
                const result = child_process.execSync('wmic logicaldisk get caption').toString();
                const driveList = result.match(/[A-Z]:/g) || [];
                drives = driveList.map(drive => ({ name: drive, path: drive + '\\', type: 'local' }));
                console.log('通过wmic获取到驱动器:', drives);
            } catch (wmicError) {
                console.warn('wmic命令执行失败，尝试备选方法:', wmicError.message);
                // 备选方法：尝试直接访问常见驱动器
                const commonDrives = ['C', 'D', 'E', 'F', 'G'];
                for (const letter of commonDrives) {
                    try {
                        const drivePath = letter + ':';
                        fs.accessSync(drivePath);
                        drives.push({ name: drivePath, path: drivePath + '\\', type: 'local' });
                        console.log(`检测到可访问驱动器: ${drivePath}`);
                    } catch (accessError) {
                        // 驱动器不存在或无法访问，忽略
                    }
                }
                
                // 如果还是没有找到驱动器，添加一个默认的C盘
                if (drives.length === 0) {
                    drives.push({ name: 'C:', path: 'C:\\', type: 'local' });
                    console.log('未找到实际驱动器，使用默认C盘');
                }
            }
        } else {
            // Unix/Linux系统获取挂载点
            try {
                const result = child_process.execSync('df -h').toString();
                const lines = result.split('\n').slice(1);
                drives = lines
                    .filter(line => line.trim())
                    .map(line => {
                        const parts = line.split(/\s+/);
                        return { name: parts[5], path: parts[5], type: 'local' };
                    });
            } catch (unixError) {
                console.error('Unix系统获取驱动器失败:', unixError);
                drives = [{ name: '/', path: '/', type: 'local' }];
            }
        }
        
        res.json(drives);
    } catch (error) {
        console.error('获取驱动器列表失败:', error);
        // 返回一个包含默认驱动器的错误响应
        res.status(500).json({ 
            error: '获取驱动器列表失败', 
            message: error.message,
            drives: [{ name: 'C:', path: 'C:\\', type: 'local' }] // 默认返回C盘
        });
    }
})

// 启动HTTP服务器
const server = app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});

// 创建WebSocket服务器
const wss = new WebSocketServer({ server });

// 存储活跃的扫描任务
const scanTasks = new Map();

// WebSocket连接处理
wss.on('connection', (ws) => {
    console.log('客户端已连接');
    
    // 客户端消息处理
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'start_scan':
                    startScan(ws, data.payload);
                    break;
                case 'stop_scan':
                    stopScan(data.payload.taskId);
                    break;
                default:
                    console.log('未知消息类型:', data.type);
            }
        } catch (error) {
            console.error('处理消息时出错:', error);
        }
    });
    
    // 连接关闭处理
    ws.on('close', () => {
        console.log('客户端已断开连接');
        // 清理该客户端的所有扫描任务
        for (const [taskId, task] of scanTasks.entries()) {
            if (task.ws === ws) {
                task.abort = true;
                scanTasks.delete(taskId);
            }
        }
    });
});

// 开始扫描任务
function startScan(ws, payload) {
    const { drivePath, scanDepth = 2 } = payload || {};
    const taskId = Date.now().toString();
    console.log(`开始扫描任务 ${taskId}，路径: ${drivePath}，深度: ${scanDepth}`);
    
    // 确保路径存在且有效
    if (!drivePath || !fs.existsSync(drivePath)) {
        console.error(`扫描路径无效: ${drivePath}`);
        ws.send(JSON.stringify({
            type: 'scan_error',
            payload: {
                taskId,
                error: `扫描路径无效: ${drivePath}`
            }
        }));
        return;
    }
    
    // 初始化扫描统计数据
    const scanStats = {
        totalFiles: 0,
        totalSize: 0,
        fileTypes: {},
        folders: {},
        applications: {},
        scannedCount: 0,
        errorCount: 0
    };
    
    // 存储扫描任务
    const task = {
        ws,
        drivePath,
        scanDepth,
        stats: scanStats,
        abort: false,
        startTime: Date.now()
    };
    
    scanTasks.set(taskId, task);
    
    // 发送任务开始消息
    ws.send(JSON.stringify({
        type: 'scan_started',
        payload: { taskId }
    }));
    
    // 异步开始扫描
    scanDirectory(drivePath, 1, scanDepth, scanStats, task, taskId)
        .then(() => {
            // 扫描完成
            if (!task.abort) {
                ws.send(JSON.stringify({
                    type: 'scan_complete',
                    payload: {
                        taskId,
                        stats: formatScanResults(scanStats),
                        duration: Math.round((Date.now() - task.startTime) / 1000)
                    }
                }));
            }
            // 从任务列表中移除
            scanTasks.delete(taskId);
        })
        .catch((error) => {
            console.error('扫描过程中出错:', error);
            if (!task.abort) {
                ws.send(JSON.stringify({
                    type: 'scan_error',
                    payload: {
                        taskId,
                        error: error.message
                    }
                }));
            }
            scanTasks.delete(taskId);
        });
}

// 停止扫描任务
function stopScan(taskId) {
    const task = scanTasks.get(taskId);
    if (task) {
        task.abort = true;
        task.ws.send(JSON.stringify({
            type: 'scan_stopped',
            payload: { taskId }
        }));
        scanTasks.delete(taskId);
    }
}

// 递归扫描目录
async function scanDirectory(dirPath, currentDepth, maxDepth, stats, task, taskId) {
    console.log(`开始扫描目录: ${dirPath}, 深度: ${currentDepth}`);
    
    // 检查是否需要中止扫描
    if (task.abort) {
        console.log(`扫描任务 ${taskId} 已中止`);
        throw new Error('扫描已中止');
    }
    
    // 确保路径存在且有效
    if (!dirPath || !fs.existsSync(dirPath)) {
        console.error(`扫描路径无效: ${dirPath}`);
        stats.errorCount++;
        return;
    }
    
    try {
        // 规范化路径
        const normalizedPath = path.normalize(dirPath);
        
        // 检查路径是否存在且可读
        if (!fs.existsSync(normalizedPath)) {
            console.warn(`路径不存在: ${normalizedPath}`);
            stats.errorCount++;
            return;
        }
        
        // 检查权限
        try {
            fs.accessSync(normalizedPath, fs.constants.R_OK);
        } catch (accessError) {
            console.warn(`无权限访问路径: ${normalizedPath}`);
            stats.errorCount++;
            return;
        }
        
        // 使用try-catch处理readdirSync可能的异常
        let entries;
        try {
            entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
        } catch (readError) {
            console.error(`读取目录出错: ${normalizedPath}`, readError.message);
            stats.errorCount++;
            return;
        }
        
        for (const entry of entries) {
            // 检查是否需要中止扫描
            if (task.abort) {
                console.log(`扫描任务 ${taskId} 已中止`);
                throw new Error('扫描已中止');
            }
            
            const fullPath = path.join(dirPath, entry.name);
            
            try {
                if (entry.isDirectory()) {
                    // 统计文件夹，使用完整路径作为键
                    if (!stats.folders[fullPath]) {
                        stats.folders[fullPath] = {
                            name: getFolderName(fullPath),
                            path: fullPath,
                            size: 0
                        };
                    }
                    console.log(`找到文件夹: ${fullPath}`);
                    
                    // 递归扫描子目录，直到达到最大深度
                    if (currentDepth < maxDepth) {
                        await scanDirectory(fullPath, currentDepth + 1, maxDepth, stats, task, taskId);
                    }
                } else if (entry.isFile()) {
                    // 获取文件信息
                    const fileStats = fs.statSync(fullPath);
                    const size = fileStats.size;
                    
                    // 修复文件扩展名获取逻辑
                    let extension = path.extname(entry.name).toLowerCase();
                    if (extension.startsWith('.')) {
                        extension = extension.slice(1); // 移除前导点
                    }
                    extension = extension || '无扩展名'; // 如果没有扩展名
                    
                    // 更新统计信息
                    stats.totalFiles++;
                    stats.totalSize += size;
                    
                    // 文件类型统计 - 修复数据存储格式
                    if (!stats.fileTypes[extension]) {
                        stats.fileTypes[extension] = {
                            name: extension,  // 添加名称字段
                            count: 0,
                            size: 0,
                            description: getFileDescription(extension)
                        };
                    }
                    stats.fileTypes[extension].count++;
                    stats.fileTypes[extension].size += size;
                    
                    // 添加调试日志
                    console.log(`文件: ${entry.name}, 扩展名: ${extension}, 大小: ${size}, 类型描述: ${getFileDescription(extension)}`);
                    
                            // 扩展应用程序识别逻辑
                    const isExecutable = ['exe', 'msi', 'app', 'dmg', 'pkg', 'appx', 'msix', 'com'].includes(extension);
                    const isInAppDirectory = fullPath.toLowerCase().includes('program files') || 
                                           fullPath.toLowerCase().includes('applications') ||
                                           fullPath.toLowerCase().includes('appdata') ||
                                           fullPath.toLowerCase().includes('windows\\system32');
                    // 简化应用识别，增加更多常见应用目录
                    
                    // 应用程序统计
                    if (isExecutable || isInAppDirectory) {
                        const appName = path.basename(fullPath, `.${extension}`);
                        if (!stats.applications[appName]) {
                            stats.applications[appName] = {
                                name: appName,
                                path: fullPath,
                                size: 0
                            };
                        }
                        stats.applications[appName].size += size;
                    }
                    
                    // 更新文件夹大小 - 使用完整路径作为键，确保准确性
                    const folderPath = path.dirname(fullPath);
                    const folderKey = folderPath; // 使用完整路径作为键
                    
                    // 确保文件夹对象存在
                    if (!stats.folders[folderKey]) {
                        stats.folders[folderKey] = {
                            name: getFolderName(folderPath),
                            path: folderPath,
                            size: 0
                        };
                    }
                    console.log(`找到文件: ${fullPath}, 大小: ${size} 字节`);
                    stats.folders[folderKey].size += size;
                    
                    // 同时更新父文件夹大小，实现正确的文件夹大小累积
                    let parentPath = path.dirname(folderPath);
                    // 修复：正确判断父文件夹遍历终止条件
                    while (parentPath && parentPath !== folderPath && 
                           parentPath.length >= task.drivePath.length && 
                           parentPath.startsWith(task.drivePath)) {
                        const parentKey = parentPath;
                        if (!stats.folders[parentKey]) {
                            stats.folders[parentKey] = {
                                name: getFolderName(parentPath),
                                path: parentPath,
                                size: 0
                            };
                        }
                        stats.folders[parentKey].size += size;
                        // 向上遍历父目录
                        const newParent = path.dirname(parentPath);
                        if (newParent === parentPath) break; // 防止无限循环
                        parentPath = newParent;
                    }
                    
                    // 每扫描50个文件发送进度更新，更及时
                    stats.scannedCount++;
                    if (stats.scannedCount % 50 === 0) {
                        // 直接使用传入的taskId
                        if (taskId && task.ws.readyState === 1) { // 确保WebSocket连接正常
                            task.ws.send(JSON.stringify({
                                type: 'scan_progress',
                                payload: {
                                    taskId: taskId,
                                    scannedCount: stats.scannedCount,
                                    totalSize: stats.totalSize,
                                    errorCount: stats.errorCount,
                                    currentPath: fullPath,
                                    percentage: Math.min(99, Math.floor(stats.scannedCount / 100)) // 简单估算进度
                                }
                            }));
                        }
                    }
                }
            } catch (error) {
                // 处理权限错误等异常
                console.warn(`无法访问 ${fullPath}:`, error.message);
                stats.errorCount++;
                // 继续扫描其他文件，不中断整个过程
                continue;
            }
        }
    } catch (error) {
        console.error(`扫描目录 ${dirPath} 时出错:`, error);
        stats.errorCount++;
        // 继续扫描，不中断整个过程
    }
}

// 获取文件夹名称（用于统计）
function getFolderName(folderPath) {
    // 确保路径有效
    if (!folderPath) return '未知文件夹';
    
    try {
        // 简化处理：获取路径的最后一部分
        const parts = folderPath.split(path.sep).filter(Boolean);
        
        // 如果路径是空的，返回根目录
        if (parts.length === 0) return '根目录';
        
        // 对于常见的系统目录，使用更友好的名称
        const folderName = parts[parts.length - 1];
        const systemFolderNames = {
            'Program Files': '程序文件',
            'Program Files (x86)': '程序文件(x86)',
            'Windows': '系统文件夹',
            'Users': '用户文件夹',
            'AppData': '应用数据',
            'Documents': '我的文档',
            'Desktop': '桌面',
            'Downloads': '下载',
            'Pictures': '图片',
            'Music': '音乐',
            'Videos': '视频'
        };
        
        if (systemFolderNames[folderName]) {
            return systemFolderNames[folderName];
        }
        
        // 对于Program Files中的文件夹，尝试获取程序名称
        if (folderPath && folderPath.toLowerCase().includes('program files')) {
            // 尝试提取程序名称
            const programFilesIndex = parts.findIndex(part => 
                part.toLowerCase().includes('program files')
            );
            if (programFilesIndex !== -1 && programFilesIndex + 1 < parts.length) {
                return parts[programFilesIndex + 1];
            }
        }
        
        // 返回路径的最后一部分作为文件夹名称
        return folderName;
    } catch (error) {
        console.error('获取文件夹名称出错:', error);
        return '未知文件夹';
    }
}

// 获取文件类型描述
function getFileDescription(extension) {
    const descriptions = {
        'exe': '可执行文件',
        'dll': '动态链接库',
        'sys': '系统文件',
        'docx': 'Word文档',
        'xlsx': 'Excel表格',
        'pptx': 'PowerPoint演示文稿',
        'pdf': 'PDF文档',
        'txt': '文本文件',
        'jpg': 'JPEG图片',
        'jpeg': 'JPEG图片',
        'png': 'PNG图片',
        'gif': 'GIF图片',
        'bmp': 'BMP图片',
        'mp3': 'MP3音频',
        'wav': 'WAV音频',
        'mp4': 'MP4视频',
        'avi': 'AVI视频',
        'mkv': 'MKV视频',
        'zip': 'ZIP压缩包',
        'rar': 'RAR压缩包',
        '7z': '7Z压缩包',
        'js': 'JavaScript文件',
        'css': 'CSS样式文件',
        'html': 'HTML文件',
        'json': 'JSON文件',
        'xml': 'XML文件',
        'sql': 'SQL文件',
        'php': 'PHP文件',
        'py': 'Python文件',
        'java': 'Java文件',
        'c': 'C语言文件',
        'cpp': 'C++文件',
        'cs': 'C#文件',
        'go': 'Go语言文件',
        'rb': 'Ruby文件',
        'swift': 'Swift文件',
        'kt': 'Kotlin文件',
        'md': 'Markdown文件',
        'log': '日志文件',
        'bak': '备份文件',
        'tmp': '临时文件'
    };
    
    return descriptions[extension] || `${extension.toUpperCase()}文件`;
}

// 格式化扫描结果
function formatScanResults(stats) {
    console.log('开始格式化扫描结果:', {
        totalFiles: stats.totalFiles,
        totalSize: stats.totalSize,
        fileTypeCount: Object.keys(stats.fileTypes).length,
        folderCount: Object.keys(stats.folders).length,
        appCount: Object.keys(stats.applications).length
    });
    
    // 格式化文件类型数据 - 修复数据映射
    const fileTypes = Object.entries(stats.fileTypes)
        .map(([ext, data]) => {
            console.log(`格式化文件类型: ${ext}, 数据:`, data);
            return {
                name: data.name || ext,  // 使用存储的名称或扩展名
                type: ext,
                description: data.description || getFileDescription(ext),
                count: data.count || 0,
                size: data.size || 0
            };
        })
        .filter(item => item.size > 0) // 确保只包含有大小的项目
        .sort((a, b) => b.size - a.size) // 按大小排序
        .slice(0, 20); // 只返回前20个最主要的类型
    
    // 格式化文件夹数据 - 修正处理对象格式的文件夹数据
    const folders = Object.entries(stats.folders)
        .map(([key, folderData]) => {
            // 检查folderData是对象还是数字
            if (typeof folderData === 'object' && folderData !== null) {
                return {
                    name: folderData.name,
                    path: folderData.path,
                    size: folderData.size
                };
            } else {
                // 兼容旧格式
                return {
                    name: key,
                    size: folderData
                };
            }
        })
        .filter(item => item.size > 0 && item.name) // 确保只包含有效的文件夹
        .sort((a, b) => b.size - a.size) // 按大小排序
        .slice(0, 20); // 只返回前20个最大的文件夹
    
    // 格式化应用程序数据
    const applications = Object.entries(stats.applications)
        .map(([key, appData]) => {
            // 检查appData是对象还是数字
            if (typeof appData === 'object' && appData !== null) {
                return {
                    name: appData.name,
                    path: appData.path,
                    size: appData.size
                };
            } else {
                // 兼容旧格式
                return {
                    name: key,
                    size: appData
                };
            }
        })
        .filter(item => item.size > 0) // 确保只包含有大小的应用
        .sort((a, b) => b.size - a.size) // 按大小排序
        .slice(0, 20); // 只返回前20个最大的应用
    
    console.log('格式化完成:', {
        fileTypesCount: fileTypes.length,
        foldersCount: folders.length,
        applicationsCount: applications.length
    });
    
    // 如果没有应用程序数据，添加一个虚拟项目避免前端显示空白
    if (applications.length === 0) {
        applications.push({
            name: '未识别应用',
            size: 1 // 给一个很小的大小，避免图表显示问题
        });
    }
    
    return {
        totalFiles: stats.totalFiles,
        totalSize: stats.totalSize,
        fileTypes,
        folders,
        applications,
        errorCount: stats.errorCount
    };
}