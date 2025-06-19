import {
	Box3,
	WebGLRenderer,
	Scene,
	DirectionalLight,
	AmbientLight,
	Group,
	MeshStandardMaterial,
	MeshBasicMaterial,
	BufferGeometry,
	LineSegments,
	LineBasicMaterial,
	PerspectiveCamera,
	Object3D,
} from 'three';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ProjectionGenerator } from '..';
import { ProjectionGeneratorWorker } from '../src/worker/ProjectionGeneratorWorker.js';
import { generateEdges } from '../src/utils/generateEdges.js';

Object3D.DEFAULT_UP.set(0, 0, 1);

const params = {
	displayModel: 'color',
	displayEdges: false,
	displayProjection: true,
	sortEdges: true,
	includeIntersectionEdges: false,
	useWorker: true,
	projectionDirection: 'top',
	rotate: () => {

		group.quaternion.random();
		group.position.set(0, 0, 0);
		group.updateMatrixWorld(true);

		const box = new Box3();
		box.setFromObject(model, true);
		box.getCenter(group.position).multiplyScalar(- 1);
		group.position.y = Math.max(0, - box.min.y) + 1;

	},
	regenerate: () => {

		task = updateEdges();

	},
};

const ANGLE_THRESHOLD = 3;
let renderer, camera, scene, gui, controls;
let lines, model, projection, group, shadedWhiteModel, whiteModel;
let outputContainer;
let worker;
let task = null;

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

	const gltfLoader = await new GLTFLoader()
	gltfLoader.setMeshoptDecoder(MeshoptDecoder)
	const dr = new DRACOLoader()
	dr.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/")
	gltfLoader.setDRACOLoader(dr)
	const gltf = await gltfLoader.loadAsync("http://127.0.0.1:8080/SFL-CPD20-Y.glb");
	model = gltf.scene;

	const whiteMaterial = new MeshStandardMaterial({
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	});
	shadedWhiteModel = model.clone();
	shadedWhiteModel.traverse(c => {

		if (c.material) {

			c.material = whiteMaterial;

		}

	});

	const whiteBasicMaterial = new MeshBasicMaterial({
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	});
	whiteModel = model.clone();
	whiteModel.traverse(c => {

		if (c.material) {

			c.material = whiteBasicMaterial;

		}

	});

	group.updateMatrixWorld(true);

	// center model
	const box = new Box3();
	box.setFromObject(model, true);
	box.getCenter(group.position);
	group.position.y = Math.max(0, - box.min.y) + Math.abs(box.max.y);
	group.add(model, shadedWhiteModel);
	group.position.z= 0
	console.log(group.position);

	// generate geometry line segments
	lines = new Group();
	model.traverse(c => {

		if (c.geometry) {

			const edges = generateEdges(c.geometry, undefined, ANGLE_THRESHOLD);
			const points = edges.flatMap(line => [line.start, line.end]);
			const geom = new BufferGeometry();
			geom.setFromPoints(points);

			const geomLines = new LineSegments(geom, new LineBasicMaterial({ color: 0x000000 }));
			geomLines.position.copy(c.position);
			geomLines.quaternion.copy(c.quaternion);
			geomLines.scale.copy(c.scale);
			lines.add(geomLines);

		}

	});
	group.add(lines);

	// create projection display mesh
	projection = new LineSegments(new BufferGeometry(), new LineBasicMaterial({
		color: 0x000000
	}));
	scene.add(projection);

	// camera setup
	camera = new PerspectiveCamera(39.5, window.innerWidth / window.innerHeight, 0.01, 500);
	camera.position.setScalar(3.5);
	camera.updateProjectionMatrix();
	camera.lookAt(0, 0, 0);

	// controls
	controls = new OrbitControls(camera, renderer.domElement);

	gui = new GUI();
	gui.add(params, 'displayModel', [
		'none',
		'color',
		'shaded white',
		// 'white',
	]);
	gui.add( params, 'displayEdges' );
	gui.add( params, 'projectionDirection', [
		'top',
		'front',
		'left',
		'back',
		'right',
		'bottom',
	] );
	gui.add(params, 'displayProjection');
	gui.add(params, 'sortEdges');
	gui.add(params, 'includeIntersectionEdges');
	gui.add(params, 'useWorker');
	gui.add(params, 'rotate');
	gui.add(params, 'regenerate');

	// 创建 worker - 可以选择使用 inline worker
	const useInlineWorker = false; // 设置为 true 使用 inline worker
	worker = new ProjectionGeneratorWorker(useInlineWorker);
	
	if (useInlineWorker) {
		console.log('Using inline worker');
	} else {
		console.log('Using external worker file');
	}

	task = updateEdges();

	render();

	window.addEventListener('resize', function () {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();

		renderer.setSize(window.innerWidth, window.innerHeight);

	}, false);

}

function* updateEdges(runTime = 30) {

	outputContainer.innerText = 'processing: --';

	// transform and merge geometries to project into a single model
	let timeStart = window.performance.now();
	const geometries = [];
	model.updateWorldMatrix(true, true);
	model.traverse(c => {

		if (c.geometry) {

			const clone = c.geometry.clone();
			clone.applyMatrix4(c.matrixWorld);

			// 确保 morphTargetsRelative 属性一致
			clone.morphTargetsRelative = false;

			// 删除所有的 morph 属性，因为我们只需要位置信息
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

	if (params.includeIntersectionEdges) {

		outputContainer.innerText = 'processing: finding edge intersections...';
		projection.geometry.dispose();
		projection.geometry = new BufferGeometry();

	}

	// generate the candidate edges
	timeStart = window.performance.now();

	let geometry = null;
	if (!params.useWorker) {

		const generator = new ProjectionGenerator();
		generator.projectionDirection = params.projectionDirection;
		generator.sortEdges = params.sortEdges;
		generator.iterationTime = runTime;
		generator.angleThreshold = ANGLE_THRESHOLD;
		generator.includeIntersectionEdges = params.includeIntersectionEdges;

		const task = generator.generate(mergedGeometry, {

			onProgress: (p, data) => {

				outputContainer.innerText = `processing: ${parseFloat((p * 100).toFixed(2))}%`;
				if (params.displayProjection) {

					projection.geometry.dispose();
					projection.geometry = data.getLineGeometry();

				}


			},

		});

		let result = task.next();
		while (!result.done) {

			result = task.next();
			yield;

		}

		geometry = result.value;

	} else {

		console.log(params.projectionDirection);
		worker
			.generate(mergedGeometry, {
				sortEdges: params.sortEdges,
				projectionDirection: params.projectionDirection,
				includeIntersectionEdges: params.includeIntersectionEdges,
				iterationTime: runTime,
				angleThreshold: ANGLE_THRESHOLD,
				onProgress: p => {

					outputContainer.innerText = `processing: ${parseFloat((p * 100).toFixed(2))}%`;

				},
			})
			.then(result => {

				geometry = result;

			});

		while (geometry === null) {

			yield;

		}

	}

	const trimTime = window.performance.now() - timeStart;

	projection.geometry.dispose();
	projection.geometry = geometry;
	outputContainer.innerText =
		`merge geometry  : ${mergeTime.toFixed(2)}ms\n` +
		`edge trimming   : ${trimTime.toFixed(2)}ms`;

}


function render() {

	requestAnimationFrame(render);

	if (task) {

		const res = task.next();
		if (res.done) {

			task = null;

		}

	}

	model.visible = params.displayModel === 'color';
	shadedWhiteModel.visible = params.displayModel === 'shaded white';
	whiteModel.visible = params.displayModel === 'white';
	lines.visible = params.displayEdges;
	projection.visible = params.displayProjection;

	renderer.render(scene, camera);

}
