import { BufferAttribute, BufferGeometry } from 'three';
import { createInlineWorker } from '../utils/worker';
import { BufferAttribute, BufferGeometry } from 'three';
import { ProjectionGenerator } from '../ProjectionGenerator.js';

function myWorker() {
	onmessage = function ( { data } ) {

		let prevTime = performance.now();
		function onProgressCallback( progress ) {
	
			const currTime = performance.now();
			if ( currTime - prevTime >= 10 || progress === 1.0 ) {
	
				postMessage( {
	
					error: null,
					progress,
	
				} );
				prevTime = currTime;
	
			}
	
		}
	
		try {
	
			const { index, position, options } = data;
			const geometry = new BufferGeometry();
			geometry.setIndex( new BufferAttribute( index, 1, false ) );
			geometry.setAttribute( 'position', new BufferAttribute( position, 3, false ) );
	
			const generator = new ProjectionGenerator();
			generator.projectionDirection = options.projectionDirection ?? generator.projectionDirection;
			generator.sortEdges = options.sortEdges ?? generator.sortEdges;
			generator.angleThreshold = options.angleThreshold ?? generator.angleThreshold;
			generator.includeIntersectionEdges = options.includeIntersectionEdges ?? generator.includeIntersectionEdges;
	
			const task = generator.generate( geometry, {
				onProgress: onProgressCallback,
			} );
	
			let result = task.next();
			while ( ! result.done ) {
	
				result = task.next();
	
			}
	
			const resultLines = result.value.attributes.position.array;
			postMessage( {
	
				result: resultLines,
				error: null,
				progress: 1,
	
			}, [ resultLines.buffer ] );
	
		} catch ( error ) {
	
			postMessage( {
	
				error,
				progress: 1,
	
			} );
	
		}
	
	};
}

const NAME = 'ProjectionGeneratorWorker';
export class ProjectionGeneratorWorker {

	constructor() {

		this.running = false;
		this.worker = createInlineWorker(myWorker);
		// this.worker = new Worker( new URL( './projectionAsync.worker.js', import.meta.url ), { type: 'module' } );
		this.worker.onerror = e => {

			if ( e.message ) {

				throw new Error( `${ NAME }: Could not create Web Worker with error "${ e.message }"` );

			} else {

				throw new Error( `${ NAME }: Could not create Web Worker.` );

			}

		};

	}

	generate( geometry, options = {} ) {

		if ( this.running ) {

			throw new Error( `${ NAME }: Already running job.` );

		}

		if ( this.worker === null ) {

			throw new Error( `${ NAME }: Worker has been disposed.` );

		}

		const { worker } = this;
		this.running = true;

		return new Promise( ( resolve, reject ) => {

			worker.onerror = e => {

				reject( new Error( `${ NAME }: ${ e.message }` ) );
				this.running = false;

			};

			worker.onmessage = e => {

				this.running = false;
				const { data } = e;

				if ( data.error ) {

					reject( new Error( data.error ) );
					worker.onmessage = null;

				} else if ( data.result ) {

					const geometry = new BufferGeometry();
					geometry.setAttribute( 'position', new BufferAttribute( data.result, 3, false ) );
					resolve( geometry );
					worker.onmessage = null;

				} else if ( options.onProgress ) {

					options.onProgress( data.progress );

				}

			};

			const index = geometry.index ? geometry.index.array.slice() : null;
			const position = geometry.attributes.position.array.slice();
			const transfer = [ position.buffer ];
			if ( index ) {

				transfer.push( index.buffer );

			}

			worker.postMessage( {
				index,
				position,
				options: {
					...options,
					onProgress: null,
					includedProgressCallback: Boolean( options.onProgress ),
				},
			}, transfer );

		} );

	}

	dispose() {

		this.worker.terminate();
		this.worker = null;

	}

}
