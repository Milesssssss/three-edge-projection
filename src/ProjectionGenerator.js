import {
	BufferGeometry,
	Vector3,
	Line3,
	Ray,
	BufferAttribute,
	Matrix4,
	Object3D,
	Box3
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
	isYProjectedTriangleDegenerate,
	isLineTriangleEdge,
	isYProjectedLineDegenerate,
} from './utils/triangleLineUtils.js';
import { generateEdges } from './utils/generateEdges.js';
import { compressEdgeOverlaps, overlapsToLines } from './utils/overlapUtils.js';
import { trimToBeneathTriPlane } from './utils/trimToBeneathTriPlane.js';
import { getProjectedLineOverlap } from './utils/getProjectedLineOverlap.js';
import { appendOverlapRange } from './utils/getProjectedOverlaps.js';
import { generateIntersectionEdges } from './utils/generateIntersectionEdges.js';

// these shared variables are not used across "yield" boundaries in the
// generator so there's no risk of overwriting another tasks data
const DIST_THRESHOLD = 1e-10;
const UP_VECTOR = /* @__PURE__ */ new Vector3( 0, 1, 0 );
Object3D.DEFAULT_UP.set(0, 0, 1);

// 投影方向枚举
export const ProjectionDirection = {
	TOP: 'top',      // 俯视图
	FRONT: 'front',  // 前视图
	LEFT: 'left'     // 左视图
};

const _beneathLine = /* @__PURE__ */ new Line3();
const _ray = /* @__PURE__ */ new Ray();
const _vec = /* @__PURE__ */ new Vector3();
const _overlapLine = /* @__PURE__ */ new Line3();
const _matrix = /* @__PURE__ */ new Matrix4();
const _center = /* @__PURE__ */ new Vector3();
const _translateToOrigin = /* @__PURE__ */ new Matrix4();
const _translateBack = /* @__PURE__ */ new Matrix4();
const _box = /* @__PURE__ */ new Box3();

class EdgeSet {

	constructor() {

		this.edges = [];

	}

	getLineGeometry( y = 0 ) {

		const edges = this.edges;
		const edgeArray = new Float32Array( edges.length * 6 );
		let c = 0;
		for ( let i = 0, l = edges.length; i < l; i ++ ) {

			const line = edges[ i ];
			edgeArray[ c ++ ] = line[ 0 ];
			edgeArray[ c ++ ] = y;
			edgeArray[ c ++ ] = line[ 2 ];
			edgeArray[ c ++ ] = line[ 3 ];
			edgeArray[ c ++ ] = y;
			edgeArray[ c ++ ] = line[ 5 ];

		}

		const edgeGeom = new BufferGeometry();
		const edgeBuffer = new BufferAttribute( edgeArray, 3, true );
		edgeGeom.setAttribute( 'position', edgeBuffer );
		return edgeGeom;

	}

}

export class ProjectionGenerator {

	constructor() {

		this.sortEdges = true;
		this.iterationTime = 30;
		this.angleThreshold = 50;
		this.includeIntersectionEdges = true;
		this.projectionDirection = ProjectionDirection.TOP; // 默认前视图

	}

	generateAsync( geometry, options = {} ) {

		return new Promise( ( resolve, reject ) => {

			const { signal } = options;
			const task = this.generate( geometry, options );
			run();

			function run() {

				if ( signal && signal.aborted ) {

					reject( new Error( 'ProjectionGenerator: Process aborted via AbortSignal.' ) );
					return;

				}

				const result = task.next();
				if ( result.done ) {

					resolve( result.value );

				} else {

					requestAnimationFrame( run );

				}

			}


		} );

	}

	*generate( bvh, options = {} ) {

		const { onProgress } = options;
		const { sortEdges, iterationTime, angleThreshold, includeIntersectionEdges, projectionDirection } = this;

		if ( bvh instanceof BufferGeometry ) {

			// 克隆几何体，避免修改原始数据
			const geometry = bvh.clone();
			
			// 计算几何体的中心点
			_box.setFromBufferAttribute(geometry.attributes.position);
			_box.getCenter(_center);
			
			// 创建变换矩阵
			_translateToOrigin.makeTranslation(-_center.x, -_center.y, -_center.z);
			_translateBack.makeTranslation(_center.x, _center.y, _center.z);
			
			// 根据投影方向旋转几何体
			switch (projectionDirection) {
				case ProjectionDirection.FRONT:
					_matrix.makeRotationX(-Math.PI / 2);
					geometry.applyMatrix4(_translateToOrigin);
					geometry.applyMatrix4(_matrix);
					geometry.applyMatrix4(_translateBack);
					break;
				case ProjectionDirection.LEFT:
					_matrix.makeRotationZ(-Math.PI / 2);
					geometry.applyMatrix4(_translateToOrigin);
					geometry.applyMatrix4(_matrix);
					geometry.applyMatrix4(_translateBack);
					break;
				// TOP视图不需要旋转
			}
			
			bvh = new MeshBVH( geometry, { maxLeafTris: 1 } );

		}

		// find the set of edges of intersecting triangles
		const geometry = bvh.geometry;
		let edges = generateEdges( geometry, UP_VECTOR, angleThreshold );
		if ( includeIntersectionEdges ) {

			const results = yield* generateIntersectionEdges( bvh, iterationTime );
			edges = edges.concat( results );

		}

		// sort the edges from lowest to highest
		if ( sortEdges ) {

			edges.sort( ( a, b ) => {

				return Math.min( a.start.y, a.end.y ) - Math.min( b.start.y, b.end.y );

			} );

		}

		yield;

		// trim the candidate edges
		const finalEdges = new EdgeSet();
		let time = performance.now();
		for ( let i = 0, l = edges.length; i < l; i ++ ) {

			const line = edges[ i ];
			if ( isYProjectedLineDegenerate( line ) ) {

				continue;

			}

			const lowestLineY = Math.min( line.start.y, line.end.y );
			const highestLineY = Math.max( line.start.y, line.end.y );
			const hiddenOverlaps = [];
			bvh.shapecast( {

				intersectsBounds: box => {

					// expand the bounding box to the bottom height of the line
					box.min.y = Math.min( lowestLineY - 1e-6, box.min.y );

					// get the line as a ray
					const { origin, direction } = _ray;
					origin.copy( line.start );
					line.delta( direction ).normalize();

					// if the ray is inside the box then we intersect it
					if ( box.containsPoint( origin ) ) {

						return true;

					}

					// check if the line segment intersects the box
					if ( _ray.intersectBox( box, _vec ) ) {

						return origin.distanceToSquared( _vec ) < line.distanceSq();

					}

					return false;

				},

				intersectsTriangle: tri => {

					// skip the triangle if the triangle is completely below the line
					const highestTriangleY = Math.max( tri.a.y, tri.b.y, tri.c.y );
					if ( highestTriangleY <= lowestLineY ) {

						return false;

					}

					// if the projected triangle is just a line then don't check it
					if ( isYProjectedTriangleDegenerate( tri ) ) {

						return false;

					}

					// if this line lies on a triangle edge then don't check for visual overlaps
					// with this triangle
					if ( isLineTriangleEdge( tri, line ) ) {

						return false;

					}

					// Retrieve the portion of line that is below the plane - and skip the triangle if none
					// of it is
					const lowestTriangleY = Math.min( tri.a.y, tri.b.y, tri.c.y );
					if ( highestLineY < lowestTriangleY ) {

						_beneathLine.copy( line );

					} else if ( ! trimToBeneathTriPlane( tri, line, _beneathLine ) ) {

						return false;

					}

					// Cull overly small edges
					if ( _beneathLine.distance() < DIST_THRESHOLD ) {

						return false;

					}

					// compress the edge overlaps so we can easily tell if the whole edge is hidden already
					// and exit early
					if (
						getProjectedLineOverlap( _beneathLine, tri, _overlapLine ) &&
						appendOverlapRange( line, _overlapLine, hiddenOverlaps )
					) {

						compressEdgeOverlaps( hiddenOverlaps );

					}

					// if we're hiding the edge entirely now then skip further checks
					if ( hiddenOverlaps.length !== 0 ) {

						const [ d0, d1 ] = hiddenOverlaps[ hiddenOverlaps.length - 1 ];
						return d0 === 0.0 && d1 === 1.0;

					}

					return false;

				},

			} );

			// convert the overlap points to proper lines
			overlapsToLines( line, hiddenOverlaps, finalEdges.edges );

			const delta = performance.now() - time;
			if ( delta > iterationTime ) {

				if ( onProgress ) {

					const progress = i / edges.length;
					onProgress( progress, finalEdges );

				}

				yield;
				time = performance.now();

			}

		}

		return finalEdges.getLineGeometry( 0 );

	}

}
