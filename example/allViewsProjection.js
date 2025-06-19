import {
    Box3,
    WebGLRenderer,
    Scene,
    DirectionalLight,
    AmbientLight,
    Group,
    MeshStandardMaterial,
    BufferGeometry,
    LineSegments,
    LineBasicMaterial,
    PerspectiveCamera,
    Object3D,
    Vector3,
    Euler,
} from 'three';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ProjectionGenerator } from '..';

Object3D.DEFAULT_UP.set(0, 0, 1);

const params = {
    displayModel: true,
    displayProjections: true,
    includeIntersectionEdges: false,
    angleThreshold: 10,
    regenerate: () => {
        task = updateProjections();
    },
    exportJSON: () => {
        exportGeometriesToJSON();
    },
    exportSeparateFiles: false, // 是否导出为单独的文件
};

let renderer, camera, scene, gui, controls;
let model, group;
let outputContainer;
let task = null;

// 存储生成的结果
let generatedResults = null;

// 存储6个视图的投影
const projections = {
    top: null,
    bottom: null,
    front: null,
    back: null,
    left: null,
    right: null
};

// 视图位置和颜色配置
const viewConfig = {
    top: { 
        position: new Vector3(0, 0, 3), 
        color: 0x333333,
        rotate: new Euler(Math.PI / 2, 0, 0)
     },
    bottom: { 
        position: new Vector3(0, 0, -3),
         color: 0x000000,
         rotate: new Euler(-Math.PI / 2, 0, 0)
     },
    front: { 
        position: new Vector3(0, 3, 0), color: 0x000000,
        rotate: new Euler(0, 0, Math.PI / 2)
     },
    back: { position: new Vector3(0, -3, 0), color: 0x000000,
        rotate: new Euler(0, 0, -Math.PI / 2) },
    left: { position: new Vector3(-3, 0, 0), color: 0x000000 },
    right: { position: new Vector3(3, 0, 0), color: 0x000000,
        rotate: new Euler(0, 0, Math.PI) }
};

init();

async function init() {

    outputContainer = document.getElementById('output');

    const bgColor = 0xeeeeee;

    // renderer setup
    renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(bgColor, 1);
    document.body.appendChild(renderer.domElement);

    // scene setup
    scene = new Scene();

    // lights
    const light = new DirectionalLight(0xffffff, 3.5);
    light.position.set(1, 2, 3);
    scene.add(light);

    const ambientLight = new AmbientLight(0xb0bec5, 0.5);
    scene.add(ambientLight);

    // load model
    group = new Group();
    scene.add(group);

    const gltfLoader = new GLTFLoader();
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    const dr = new DRACOLoader();
    dr.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
    gltfLoader.setDRACOLoader(dr);
    const gltf = await gltfLoader.loadAsync("http://127.0.0.1:8080/SFL-CPD20-Y.glb");
    model = gltf.scene;

    const whiteMaterial = new MeshStandardMaterial({
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        opacity: 0.5,
        transparent: true
    });

    model.traverse(c => {
        if (c.material) {
            c.material = whiteMaterial;
        }
    });

    group.updateMatrixWorld(true);

    // center model
    const box = new Box3();
    box.setFromObject(model, true);
    box.getCenter(group.position);
    group.position.multiplyScalar(-1);
    group.add(model);

    // 初始化6个视图的投影线段
    for (const [view, config] of Object.entries(viewConfig)) {
        const projection = new LineSegments(
            new BufferGeometry(),
            new LineBasicMaterial({
                color: config.color,
                linewidth: 2
            })
        );
        projection.position.set(0,0,0)
        if (config.rotate) {
            projection.rotation.copy(config.rotate);
        }
        // projection.position.copy(config.position);
        scene.add(projection);
        projections[view] = projection;
    }

    // camera setup
    camera = new PerspectiveCamera(39.5, window.innerWidth / window.innerHeight, 0.01, 500);
    camera.position.set(10, 10, 10);
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    // controls
    controls = new OrbitControls(camera, renderer.domElement);

    gui = new GUI();
    gui.add(params, 'displayModel');
    gui.add(params, 'displayProjections');
    gui.add(params, 'includeIntersectionEdges').onChange(() => params.regenerate());
    gui.add(params, 'angleThreshold', 1, 90, 1).onChange(() => params.regenerate());
    gui.add(params, 'regenerate');

    // 添加每个视图的显示控制
    const viewFolder = gui.addFolder('Views');
    for (const view of Object.keys(projections)) {
        params[`show_${view}`] = true;
        viewFolder.add(params, `show_${view}`).name(view);
    }
    viewFolder.open();

    // 添加导出选项
    const exportFolder = gui.addFolder('Export');
    exportFolder.add(params, 'exportSeparateFiles').name('Separate Files');
    exportFolder.add(params, 'exportJSON').name('Export to JSON');
    exportFolder.open();

    task = updateProjections();

    render();

    window.addEventListener('resize', function () {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }, false);

}

function* updateProjections() {

    outputContainer.innerText = 'Processing: preparing geometry...';

    // 准备合并的几何体
    const timeStart = window.performance.now();
    const geometries = [];
    model.updateWorldMatrix(true, true);
    model.traverse(c => {
        if (c.geometry) {
            const clone = c.geometry.clone();
            clone.applyMatrix4(c.matrixWorld);

            // 确保 morphTargetsRelative 属性一致
            clone.morphTargetsRelative = false;

            // 删除所有的 morph 属性
            if (clone.morphAttributes) {
                for (const key in clone.morphAttributes) {
                    delete clone.morphAttributes[key];
                }
            }

            for (const key in clone.attributes) {
                if (key !== 'position') {
                    clone.deleteAttribute(key);
                }
            }

            geometries.push(clone);
        }
    });

    const mergedGeometry = mergeGeometries(geometries, false);
    const mergeTime = window.performance.now() - timeStart;

    yield;

    // 使用 ProjectionGenerator 生成所有视图
    const generator = new ProjectionGenerator();
    generator.generateAllViews = true; // 启用生成所有视图
    generator.angleThreshold = params.angleThreshold;
    generator.includeIntersectionEdges = params.includeIntersectionEdges;
    generator.sortEdges = true;
    generator.iterationTime = 30;

    const genTask = generator.generate(mergedGeometry, {
        onProgress: (overall, data) => {
            const { currentView, viewProgress } = data;
            outputContainer.innerText =
                `Processing: ${currentView} view - ${parseFloat((viewProgress * 100).toFixed(1))}%\n` +
                `Overall: ${parseFloat((overall * 100).toFixed(1))}%`;
        }
    });

    let result = genTask.next();
    while (!result.done) {
        result = genTask.next();
        yield;
    }

    // 保存结果
    const results = result.value;
    generatedResults = results;

    // 更新所有投影
    for (const [view, geometry] of Object.entries(results)) {
        if (projections[view]) {
            projections[view].geometry.dispose();
            projections[view].geometry = geometry;
        }
    }

    // 清理合并的几何体
    mergedGeometry.dispose();

    const totalTime = window.performance.now() - timeStart;
    outputContainer.innerText =
        `Complete!\n` +
        `Merge geometry: ${mergeTime.toFixed(2)}ms\n` +
        `Total time: ${totalTime.toFixed(2)}ms\n` +
        `Average per view: ${((totalTime - mergeTime) / 6).toFixed(2)}ms`;

}

function render() {

    requestAnimationFrame(render);

    if (task) {
        const res = task.next();
        if (res.done) {
            task = null;
        }
    }

    // 更新模型和投影的可见性
    model.visible = params.displayModel;

    for (const [view, projection] of Object.entries(projections)) {
        projection.visible = params.displayProjections && params[`show_${view}`];
    }

    renderer.render(scene, camera);

}

// 导出几何体为 JSON
function exportGeometriesToJSON() {
    if (!generatedResults) {
        alert('请先生成投影！');
        return;
    }

    if (params.exportSeparateFiles) {
        // 导出为单独的文件
        for (const [view, geometry] of Object.entries(generatedResults)) {
            const json = geometryToJSON(geometry);
            downloadJSON(json, `projection_${view}.json`);
        }
    } else {
        // 导出为一个合并的文件
        const allViewsData = {};
        for (const [view, geometry] of Object.entries(generatedResults)) {
            allViewsData[view] = geometryToJSON(geometry);
        }

        const metadata = {
            generator: 'three-edge-projection',
            version: '1.0',
            timestamp: new Date().toISOString(),
            views: Object.keys(generatedResults),
            settings: {
                angleThreshold: params.angleThreshold,
                includeIntersectionEdges: params.includeIntersectionEdges
            }
        };

        const json = {
            metadata,
            geometries: allViewsData
        };

        downloadJSON(json, 'projections_all_views.json');
    }
}

// 将 BufferGeometry 转换为 JSON
function geometryToJSON(geometry) {
    const data = {
        type: 'BufferGeometry',
        attributes: {}
    };

    // 导出属性
    for (const key in geometry.attributes) {
        const attribute = geometry.attributes[key];
        data.attributes[key] = {
            array: Array.from(attribute.array),
            itemSize: attribute.itemSize,
            count: attribute.count,
            normalized: attribute.normalized
        };
    }

    // 导出索引（如果有）
    if (geometry.index) {
        data.index = {
            array: Array.from(geometry.index.array),
            count: geometry.index.count
        };
    }

    return data;
}

// 下载 JSON 文件
function downloadJSON(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
} 