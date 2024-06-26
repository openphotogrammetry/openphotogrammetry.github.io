import * as THREE from 'three';
import { Ray as Ray$1, Plane, MathUtils, EventDispatcher, Vector3, MOUSE, TOUCH, Quaternion, Spherical, Vector2 } from 'three';

/**
 * AbortablePromise: A quick & dirty wrapper for JavaScript's Promise class that allows the underlying
 * asynchronous operation to be cancelled. It is only meant for simple situations where no complex promise
 * chaining or merging occurs. It needs a significant amount of work to truly replicate the full
 * functionality of JavaScript's Promise class. Look at Util.fetchWithProgress() for example usage.
 *
 * This class was primarily added to allow splat scene downloads to be cancelled. It has not been tested
 * very thoroughly and the implementation is kinda janky. If you can at all help it, please avoid using it :)
 */
class AbortablePromise {

    static idGen = 0;

    constructor(promiseFunc, abortHandler) {

        let promiseResolve;
        let promiseReject;
        this.promise = new Promise((resolve, reject) => {
            promiseResolve = resolve.bind(this);
            promiseReject = reject.bind(this);
        });

        const resolve = (...args) => {
            promiseResolve(...args);
        };

        const reject = (error) => {
            promiseReject(error);
        };

        promiseFunc(resolve.bind(this), reject.bind(this));
        this.abortHandler = abortHandler;
        this.id = AbortablePromise.idGen++;
    }

    then(onResolve) {
        return new AbortablePromise((resolve, reject) => {
            this.promise = this.promise
            .then((...args) => {
                const onResolveResult = onResolve(...args);
                if (onResolveResult instanceof Promise || onResolveResult instanceof AbortablePromise) {
                    onResolveResult.then((...args2) => {
                        resolve(...args2);
                    });
                } else {
                    resolve(onResolveResult);
                }
            })
            .catch((error) => {
                reject(error);
            });
        }, this.abortHandler);
    }

    catch(onFail) {
        return new AbortablePromise((resolve) => {
            this.promise = this.promise.then((...args) => {
                resolve(...args);
            })
            .catch(onFail);
        }, this.abortHandler);
    }

    abort() {
        if (this.abortHandler) this.abortHandler();
    }

}

class AbortedPromiseError extends Error {

    constructor(msg) {
        super(msg);
    }

}

const floatToHalf = function() {

    const floatView = new Float32Array(1);
    const int32View = new Int32Array(floatView.buffer);

    return function(val) {
        floatView[0] = val;
        const x = int32View[0];

        let bits = (x >> 16) & 0x8000;
        let m = (x >> 12) & 0x07ff;
        const e = (x >> 23) & 0xff;

        if (e < 103) return bits;

        if (e > 142) {
            bits |= 0x7c00;
            bits |= ((e == 255) ? 0 : 1) && (x & 0x007fffff);
            return bits;
        }

        if (e < 113) {
            m |= 0x0800;
            bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
            return bits;
        }

        bits |= (( e - 112) << 10) | (m >> 1);
        bits += m & 1;
        return bits;
    };

}();

const uintEncodedFloat = function() {

    const floatView = new Float32Array(1);
    const int32View = new Int32Array(floatView.buffer);

    return function(f) {
        floatView[0] = f;
        return int32View[0];
    };

}();

const rgbaToInteger = function(r, g, b, a) {
    return r + (g << 8) + (b << 16) + (a << 24);
};

const rgbaArrayToInteger = function(arr, offset) {
    return arr[offset] + (arr[offset + 1] << 8) + (arr[offset + 2] << 16) + (arr[offset + 3] << 24);
};

const fetchWithProgress = function(path, onProgress, saveChunks = true) {

    const abortController = new AbortController();
    const signal = abortController.signal;
    let aborted = false;
    let rejectFunc = null;
    const abortHandler = () => {
        abortController.abort();
        rejectFunc(new AbortedPromiseError('Fetch aborted.'));
        aborted = true;
    };

    return new AbortablePromise((resolve, reject) => {
        rejectFunc = reject;
        fetch(path, { signal })
        .then(async (data) => {
            const reader = data.body.getReader();
            let bytesDownloaded = 0;
            let _fileSize = data.headers.get('Content-Length');
            let fileSize = _fileSize ? parseInt(_fileSize) : undefined;

            const chunks = [];

            while (!aborted) {
                try {
                    const { value: chunk, done } = await reader.read();
                    if (done) {
                        if (onProgress) {
                            onProgress(100, '100%', chunk, fileSize);
                        }
                        if (saveChunks) {
                            const buffer = new Blob(chunks).arrayBuffer();
                            resolve(buffer);
                        } else {
                            resolve();
                        }
                        break;
                    }
                    bytesDownloaded += chunk.length;
                    let percent;
                    let percentLabel;
                    if (fileSize !== undefined) {
                        percent = bytesDownloaded / fileSize * 100;
                        percentLabel = `${percent.toFixed(2)}%`;
                    }
                    if (saveChunks) chunks.push(chunk);
                    if (onProgress) {
                        const cancelSaveChucnks = onProgress(percent, percentLabel, chunk, fileSize);
                        if (cancelSaveChucnks) saveChunks = false;
                    }
                } catch (error) {
                    reject(error);
                    break;
                }
            }
        });
    }, abortHandler);

};

const clamp = function(val, min, max) {
    return Math.max(Math.min(val, max), min);
};

const getCurrentTime = function() {
    return performance.now() / 1000;
};

const disposeAllMeshes = (object3D) => {
    if (object3D.geometry) {
        object3D.geometry.dispose();
        object3D.geometry = null;
    }
    if (object3D.material) {
        object3D.material.dispose();
        object3D.material = null;
    }
    if (object3D.children) {
        for (let child of object3D.children) {
            disposeAllMeshes(child);
        }
    }
};

const delayedExecute = (func, fast) => {
    return new Promise((resolve) => {
        window.setTimeout(() => {
            resolve(func());
        }, fast ? 1 : 50);
    });
};


const getSphericalHarmonicsComponentCountForDegree = (sphericalHarmonicsDegree = 0) => {
    switch (sphericalHarmonicsDegree) {
        case 1:
            return 9;
        case 2:
            return 24;
    }
    return 0;
};

const BASE_COMPONENT_COUNT = 14;

class UncompressedSplatArray {

    static OFFSET = {
        X: 0,
        Y: 1,
        Z: 2,
        SCALE0: 3,
        SCALE1: 4,
        SCALE2: 5,
        ROTATION0: 6,
        ROTATION1: 7,
        ROTATION2: 8,
        ROTATION3: 9,
        FDC0: 10,
        FDC1: 11,
        FDC2: 12,
        OPACITY: 13,
        FRC0: 14,
        FRC1: 15,
        FRC2: 16,
        FRC3: 17,
        FRC4: 18,
        FRC5: 19,
        FRC6: 20,
        FRC7: 21,
        FRC8: 22,
        FRC9: 23,
        FRC10: 24,
        FRC11: 25,
        FRC12: 26,
        FRC13: 27,
        FRC14: 28,
        FRC15: 29,
        FRC16: 30,
        FRC17: 31,
        FRC18: 32,
        FRC19: 33,
        FRC20: 34,
        FRC21: 35,
        FRC22: 36,
        FRC23: 37,
    };

    constructor(sphericalHarmonicsDegree = 0) {
        this.sphericalHarmonicsDegree = sphericalHarmonicsDegree;
        this.sphericalHarmonicsCount = getSphericalHarmonicsComponentCountForDegree(this.sphericalHarmonicsDegree);
        this.componentCount = this.sphericalHarmonicsCount + BASE_COMPONENT_COUNT;
        this.defaultSphericalHarmonics = new Array(this.sphericalHarmonicsCount).fill(0);
        this.splats = [];
        this.splatCount = 0;
    }

    static createSplat(sphericalHarmonicsDegree = 0) {
        const baseSplat = [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
        let shEntries = getSphericalHarmonicsComponentCountForDegree(sphericalHarmonicsDegree);
        for (let i = 0; i < shEntries; i++) baseSplat.push(0);
        return baseSplat;
    }

    addSplat(splat) {
        this.splats.push(splat);
        this.splatCount++;
    }

    getSplat(index) {
        return this.splats[index];
    }

    addDefaultSplat() {
        const newSplat = UncompressedSplatArray.createSplat(this.sphericalHarmonicsDegree);
        this.addSplat(newSplat);
        return newSplat;
    }

    addSplatFromComonents(x, y, z, scale0, scale1, scale2, rot0, rot1, rot2, rot3, r, g, b, opacity, ...rest) {
        const newSplat = [x, y, z, scale0, scale1, scale2, rot0, rot1, rot2, rot3, r, g, b, opacity, ...this.defaultSphericalHarmonics];
        for (let i = 0; i < rest.length && i < this.sphericalHarmonicsCount; i++) {
            newSplat[i] = rest[i];
        }
        this.addSplat(newSplat);
        return newSplat;
    }

    addSplatFromArray(src, srcIndex) {
        const srcSplat = src.splats[srcIndex];
        const newSplat = UncompressedSplatArray.createSplat(this.sphericalHarmonicsDegree);
        for (let i = 0; i < this.componentCount && i < srcSplat.length; i++) {
            newSplat[i] = srcSplat[i];
        }
        this.addSplat(newSplat);
    }
}

class Constants {

    static DepthMapRange = 1 << 16;
    static MemoryPageSize = 65536;
    static BytesPerFloat = 4;
    static BytesPerInt = 4;
    static MaxScenes = 32;
    static StreamingSectionSize = 524288;
    static SphericalHarmonics8BitCompressionRange = 3;
}

const SphericalHarmonics8BitCompressionHalfRange = Constants.SphericalHarmonics8BitCompressionRange / 2.0;

const toHalfFloat = THREE.DataUtils.toHalfFloat.bind(THREE.DataUtils);

const toUint8 = (v) => {
    v = clamp(v, -SphericalHarmonics8BitCompressionHalfRange, SphericalHarmonics8BitCompressionHalfRange);
    return clamp(Math.floor((v * (0.5 / SphericalHarmonics8BitCompressionHalfRange) + 0.5) * 255), 0, 255);
};

const fromUint8 = (v) => {
    return (v / 255) * Constants.SphericalHarmonics8BitCompressionRange - SphericalHarmonics8BitCompressionHalfRange;
};

const fromHalfFloat = THREE.DataUtils.fromHalfFloat.bind(THREE.DataUtils);

const fromHalfFloatToUint8 = (v) => {
    return toUint8(fromHalfFloat(v));
};

const toUncompressedFloat = (f, compressionLevel, isSH = false) => {
    if (compressionLevel === 0) {
        return f;
    } else if (compressionLevel === 1 || compressionLevel === 2 && !isSH) {
        return THREE.DataUtils.fromHalfFloat(f);
    } else if (compressionLevel === 2) {
        return fromUint8(f);
    }
};

const dataViewFloatForCompressionLevel = (dataView, floatIndex, compressionLevel, isSH = false) => {
    if (compressionLevel === 0) {
        return dataView.getFloat32(floatIndex * 4, true);
    } else if (compressionLevel === 1 || compressionLevel === 2 && !isSH) {
        return dataView.getUint16(floatIndex * 2, true);
    } else {
        return dataView.getUint8(floatIndex, true);
    }
};

/**
 * SplatBuffer: Container for splat data from a single scene/file and capable of (mediocre) compression.
 */
class SplatBuffer {

    static CurrentMajorVersion = 0;
    static CurrentMinorVersion = 1;

    static CenterComponentCount = 3;
    static ScaleComponentCount = 3;
    static RotationComponentCount = 4;
    static ColorComponentCount = 4;
    static CovarianceComponentCount = 6;

    static SplatScaleOffsetFloat = 3;
    static SplatRotationOffsetFloat = 6;

    static CompressionLevels = {
        0: {
            BytesPerCenter: 12,
            BytesPerScale: 12,
            BytesPerRotation: 16,
            BytesPerColor: 4,
            ScaleOffsetBytes: 12,
            RotationffsetBytes: 24,
            ColorOffsetBytes: 40,
            SphericalHarmonicsOffsetBytes: 44,
            ScaleRange: 1,
            BytesPerSphericalHarmonicsComponent: 4,
            SphericalHarmonicsOffsetFloat: 11,
            SphericalHarmonicsDegrees: {
                0: { BytesPerSplat: 44 },
                1: { BytesPerSplat: 80 },
                2: { BytesPerSplat: 140 }
            },
        },
        1: {
            BytesPerCenter: 6,
            BytesPerScale: 6,
            BytesPerRotation: 8,
            BytesPerColor: 4,
            ScaleOffsetBytes: 6,
            RotationffsetBytes: 12,
            ColorOffsetBytes: 20,
            SphericalHarmonicsOffsetBytes: 24,
            ScaleRange: 32767,
            BytesPerSphericalHarmonicsComponent: 2,
            SphericalHarmonicsOffsetFloat: 12,
            SphericalHarmonicsDegrees: {
                0: { BytesPerSplat: 24 },
                1: { BytesPerSplat: 42 },
                2: { BytesPerSplat: 72 }
            },
        },
        2: {
            BytesPerCenter: 6,
            BytesPerScale: 6,
            BytesPerRotation: 8,
            BytesPerColor: 4,
            ScaleOffsetBytes: 6,
            RotationffsetBytes: 12,
            ColorOffsetBytes: 20,
            SphericalHarmonicsOffsetBytes: 24,
            ScaleRange: 32767,
            BytesPerSphericalHarmonicsComponent: 1,
            SphericalHarmonicsOffsetFloat: 12,
            SphericalHarmonicsDegrees: {
                0: { BytesPerSplat: 24 },
                1: { BytesPerSplat: 33 },
                2: { BytesPerSplat: 48 }
            },
        }
    };

    static CovarianceSizeFloats = 6;

    static HeaderSizeBytes = 4096;
    static SectionHeaderSizeBytes = 1024;

    static BucketStorageSizeBytes = 12;
    static BucketStorageSizeFloats = 3;

    static BucketBlockSize = 5.0;
    static BucketSize = 256;

    constructor(bufferData, secLoadedCountsToMax = true) {
        this.constructFromBuffer(bufferData, secLoadedCountsToMax);
    }

    getSplatCount() {
        return this.splatCount;
    }

    getMaxSplatCount() {
        return this.maxSplatCount;
    }

    getMinSphericalHarmonicsDegree() {
        let minSphericalHarmonicsDegree = 0;
        for (let i = 0; i < this.sections.length; i++) {
            const section = this.sections[i];
            if (i === 0 || section.sphericalHarmonicsDegree < minSphericalHarmonicsDegree) {
                minSphericalHarmonicsDegree = section.sphericalHarmonicsDegree;
            }
        }
        return minSphericalHarmonicsDegree;
    }

    getBucketIndex(section, localSplatIndex) {
        let bucketIndex;
        const maxSplatIndexInFullBuckets = section.fullBucketCount * section.bucketSize;
        if (localSplatIndex < maxSplatIndexInFullBuckets) {
            bucketIndex = Math.floor(localSplatIndex / section.bucketSize);
        } else {
            let bucketSplatIndex = maxSplatIndexInFullBuckets;
            bucketIndex = section.fullBucketCount;
            let partiallyFullBucketIndex = 0;
            while (bucketSplatIndex < section.splatCount) {
                let currentPartiallyFilledBucketSize = section.partiallyFilledBucketLengths[partiallyFullBucketIndex];
                if (localSplatIndex >= bucketSplatIndex && localSplatIndex < bucketSplatIndex + currentPartiallyFilledBucketSize) {
                    break;
                }
                bucketSplatIndex += currentPartiallyFilledBucketSize;
                bucketIndex++;
                partiallyFullBucketIndex++;
            }
        }
        return bucketIndex;
    }

    getSplatCenter(globalSplatIndex, outCenter, transform) {
        const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
        const section = this.sections[sectionIndex];
        const localSplatIndex = globalSplatIndex - section.splatCountOffset;

        const srcSplatCentersBase = section.bytesPerSplat * localSplatIndex;
        const dataView = new DataView(this.bufferData, section.dataBase + srcSplatCentersBase);

        const x = dataViewFloatForCompressionLevel(dataView, 0, this.compressionLevel);
        const y = dataViewFloatForCompressionLevel(dataView, 1, this.compressionLevel);
        const z = dataViewFloatForCompressionLevel(dataView, 2, this.compressionLevel);
        if (this.compressionLevel >= 1) {
            const bucketIndex = this.getBucketIndex(section, localSplatIndex);
            const bucketBase = bucketIndex * SplatBuffer.BucketStorageSizeFloats;
            const sf = section.compressionScaleFactor;
            const sr = section.compressionScaleRange;
            outCenter.x = (x - sr) * sf + section.bucketArray[bucketBase];
            outCenter.y = (y - sr) * sf + section.bucketArray[bucketBase + 1];
            outCenter.z = (z - sr) * sf + section.bucketArray[bucketBase + 2];
        } else {
            outCenter.x = x;
            outCenter.y = y;
            outCenter.z = z;
        }
        if (transform) outCenter.applyMatrix4(transform);
    }

    getSplatScaleAndRotation = function() {

        const scaleMatrix = new THREE.Matrix4();
        const rotationMatrix = new THREE.Matrix4();
        const tempMatrix = new THREE.Matrix4();
        const tempPosition = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();

        return function(index, outScale, outRotation, transform) {
            const sectionIndex = this.globalSplatIndexToSectionMap[index];
            const section = this.sections[sectionIndex];
            const localSplatIndex = index - section.splatCountOffset;

            const srcSplatScalesBase = section.bytesPerSplat * localSplatIndex +
                                       SplatBuffer.CompressionLevels[this.compressionLevel].ScaleOffsetBytes;

            const dataView = new DataView(this.bufferData, section.dataBase + srcSplatScalesBase);

            scale.set(toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 0, this.compressionLevel), this.compressionLevel),
                      toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 1, this.compressionLevel), this.compressionLevel),
                      toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 2, this.compressionLevel), this.compressionLevel));

            rotation.set(toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 4, this.compressionLevel), this.compressionLevel),
                         toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 5, this.compressionLevel), this.compressionLevel),
                         toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 6, this.compressionLevel), this.compressionLevel),
                         toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 3, this.compressionLevel), this.compressionLevel));

            if (transform) {
                scaleMatrix.makeScale(scale.x, scale.y, scale.z);
                rotationMatrix.makeRotationFromQuaternion(rotation);
                tempMatrix.copy(scaleMatrix).multiply(rotationMatrix).multiply(transform);
                tempMatrix.decompose(tempPosition, outRotation, outScale);
            } else {
                outScale.copy(scale);
                outRotation.copy(rotation);
            }
        };

    }();

    getSplatColor(globalSplatIndex, outColor) {
        const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
        const section = this.sections[sectionIndex];
        const localSplatIndex = globalSplatIndex - section.splatCountOffset;

        const srcSplatColorsBase = section.bytesPerSplat * localSplatIndex +
                                   SplatBuffer.CompressionLevels[this.compressionLevel].ColorOffsetBytes;
        const splatColorsArray = new Uint8Array(this.bufferData, section.dataBase + srcSplatColorsBase, 4);

        outColor.set(splatColorsArray[0], splatColorsArray[1],
                     splatColorsArray[2], splatColorsArray[3]);
    }

    fillSplatCenterArray(outCenterArray, transform, srcFrom, srcTo, destFrom) {
        const splatCount = this.splatCount;

        srcFrom = srcFrom || 0;
        srcTo = srcTo || splatCount - 1;
        if (destFrom === undefined) destFrom = srcFrom;

        const center = new THREE.Vector3();
        for (let i = srcFrom; i <= srcTo; i++) {
            const sectionIndex = this.globalSplatIndexToSectionMap[i];
            const section = this.sections[sectionIndex];
            const localSplatIndex = i - section.splatCountOffset;
            const centerDestBase = (i - srcFrom + destFrom) * SplatBuffer.CenterComponentCount;

            const srcSplatCentersBase = section.bytesPerSplat * localSplatIndex;
            const dataView = new DataView(this.bufferData, section.dataBase + srcSplatCentersBase);

            const x = dataViewFloatForCompressionLevel(dataView, 0, this.compressionLevel);
            const y = dataViewFloatForCompressionLevel(dataView, 1, this.compressionLevel);
            const z = dataViewFloatForCompressionLevel(dataView, 2, this.compressionLevel);
            if (this.compressionLevel >= 1) {
                const bucketIndex = this.getBucketIndex(section, localSplatIndex);
                const bucketBase = bucketIndex * SplatBuffer.BucketStorageSizeFloats;
                const sf = section.compressionScaleFactor;
                const sr = section.compressionScaleRange;
                center.x = (x - sr) * sf + section.bucketArray[bucketBase];
                center.y = (y - sr) * sf + section.bucketArray[bucketBase + 1];
                center.z = (z - sr) * sf + section.bucketArray[bucketBase + 2];
            } else {
                center.x = x;
                center.y = y;
                center.z = z;
            }
            if (transform) {
                center.applyMatrix4(transform);
            }
            outCenterArray[centerDestBase] = center.x;
            outCenterArray[centerDestBase + 1] = center.y;
            outCenterArray[centerDestBase + 2] = center.z;
        }
    }

    static computeCovariance = function() {

        const tempMatrix4 = new THREE.Matrix4();
        const scaleMatrix = new THREE.Matrix3();
        const rotationMatrix = new THREE.Matrix3();
        const covarianceMatrix = new THREE.Matrix3();
        const transformedCovariance = new THREE.Matrix3();
        const transform3x3 = new THREE.Matrix3();
        const transform3x3Transpose = new THREE.Matrix3();

        return function(scale, rotation, transform, outCovariance, outOffset = 0, desiredOutputCompressionLevel) {

            tempMatrix4.makeScale(scale.x, scale.y, scale.z);
            scaleMatrix.setFromMatrix4(tempMatrix4);

            tempMatrix4.makeRotationFromQuaternion(rotation);
            rotationMatrix.setFromMatrix4(tempMatrix4);

            covarianceMatrix.copy(rotationMatrix).multiply(scaleMatrix);
            transformedCovariance.copy(covarianceMatrix).transpose().premultiply(covarianceMatrix);

            if (transform) {
                transform3x3.setFromMatrix4(transform);
                transform3x3Transpose.copy(transform3x3).transpose();
                transformedCovariance.multiply(transform3x3Transpose);
                transformedCovariance.premultiply(transform3x3);
            }

            if (desiredOutputCompressionLevel >= 1) {
                outCovariance[outOffset] = toHalfFloat(transformedCovariance.elements[0]);
                outCovariance[outOffset + 1] = toHalfFloat(transformedCovariance.elements[3]);
                outCovariance[outOffset + 2] = toHalfFloat(transformedCovariance.elements[6]);
                outCovariance[outOffset + 3] = toHalfFloat(transformedCovariance.elements[4]);
                outCovariance[outOffset + 4] = toHalfFloat(transformedCovariance.elements[7]);
                outCovariance[outOffset + 5] = toHalfFloat(transformedCovariance.elements[8]);
            } else {
                outCovariance[outOffset] = transformedCovariance.elements[0];
                outCovariance[outOffset + 1] = transformedCovariance.elements[3];
                outCovariance[outOffset + 2] = transformedCovariance.elements[6];
                outCovariance[outOffset + 3] = transformedCovariance.elements[4];
                outCovariance[outOffset + 4] = transformedCovariance.elements[7];
                outCovariance[outOffset + 5] = transformedCovariance.elements[8];
            }

        };

    }();

    fillSplatCovarianceArray(covarianceArray, transform, srcFrom, srcTo, destFrom, desiredOutputCompressionLevel) {
        const splatCount = this.splatCount;

        const scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();

        srcFrom = srcFrom || 0;
        srcTo = srcTo || splatCount - 1;
        if (destFrom === undefined) destFrom = srcFrom;

        for (let i = srcFrom; i <= srcTo; i++) {
            const sectionIndex = this.globalSplatIndexToSectionMap[i];
            const section = this.sections[sectionIndex];
            const localSplatIndex = i - section.splatCountOffset;

            const covarianceDestBase = (i - srcFrom + destFrom) * SplatBuffer.CovarianceComponentCount;
            const srcSplatScalesBase = section.bytesPerSplat * localSplatIndex +
                                       SplatBuffer.CompressionLevels[this.compressionLevel].ScaleOffsetBytes;

            const dataView = new DataView(this.bufferData, section.dataBase + srcSplatScalesBase);

            scale.set(toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 0, this.compressionLevel), this.compressionLevel),
                      toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 1, this.compressionLevel), this.compressionLevel),
                      toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 2, this.compressionLevel), this.compressionLevel));
            rotation.set(toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 4, this.compressionLevel), this.compressionLevel),
                         toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 5, this.compressionLevel), this.compressionLevel),
                         toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 6, this.compressionLevel), this.compressionLevel),
                         toUncompressedFloat(dataViewFloatForCompressionLevel(dataView, 3, this.compressionLevel), this.compressionLevel));

            SplatBuffer.computeCovariance(scale, rotation, transform, covarianceArray, covarianceDestBase, desiredOutputCompressionLevel);
        }
    }

    fillSplatColorArray(outColorArray, minimumAlpha, srcFrom, srcTo, destFrom) {
        const splatCount = this.splatCount;

        srcFrom = srcFrom || 0;
        srcTo = srcTo || splatCount - 1;
        if (destFrom === undefined) destFrom = srcFrom;

        for (let i = srcFrom; i <= srcTo; i++) {

            const sectionIndex = this.globalSplatIndexToSectionMap[i];
            const section = this.sections[sectionIndex];
            const localSplatIndex = i - section.splatCountOffset;

            const colorDestBase = (i - srcFrom + destFrom) * SplatBuffer.ColorComponentCount;
            const srcSplatColorsBase = section.bytesPerSplat * localSplatIndex +
                                       SplatBuffer.CompressionLevels[this.compressionLevel].ColorOffsetBytes;

            const dataView = new Uint8Array(this.bufferData, section.dataBase + srcSplatColorsBase);

            let alpha = dataView[3];
            alpha = (alpha >= minimumAlpha) ? alpha : 0;

            outColorArray[colorDestBase] = dataView[0];
            outColorArray[colorDestBase + 1] = dataView[1];
            outColorArray[colorDestBase + 2] = dataView[2];
            outColorArray[colorDestBase + 3] = alpha;
        }
    }

    fillSphericalHarmonicsArray = function() {

        const sphericalHarmonicVectors = [];
        for (let i = 0; i < 15; i++) {
            sphericalHarmonicVectors[i] = new THREE.Vector3();
        }

        const tempMatrix3 = new THREE.Matrix3();

        const sh11 = [];
        const sh12 = [];
        const sh13 = [];

        const sh21 = [];
        const sh22 = [];
        const sh23 = [];
        const sh24 = [];
        const sh25 = [];

        const shIn1 = [];
        const shIn2 = [];
        const shIn3 = [];
        const shIn4 = [];
        const shIn5 = [];

        const shOut1 = [];
        const shOut2 = [];
        const shOut3 = [];
        const shOut4 = [];
        const shOut5 = [];

        const noop = (v) => v;

        const set3 = (array, val1, val2, val3) => {
            array[0] = val1;
            array[1] = val2;
            array[2] = val3;
        };

        const set3FromArray = (array, srcDestView, stride, srcBase, compressionLevel) => {
            array[0] = dataViewFloatForCompressionLevel(srcDestView, srcBase, compressionLevel, true);
            array[1] = dataViewFloatForCompressionLevel(srcDestView, srcBase + stride, compressionLevel, true);
            array[2] = dataViewFloatForCompressionLevel(srcDestView, srcBase + stride + stride, compressionLevel, true);
        };

        const copy3 = (srcArray, destArray) => {
            destArray[0] = srcArray[0];
            destArray[1] = srcArray[1];
            destArray[2] = srcArray[2];
        };

        const setOutput3 = (srcArray, destArray, destBase, conversionFunc) => {
            destArray[destBase] = conversionFunc(srcArray[0]);
            destArray[destBase + 1] = conversionFunc(srcArray[1]);
            destArray[destBase + 2] = conversionFunc(srcArray[2]);
        };

        const toUncompressedFloatArray3 = (src, dest, compressionLevel) => {
            dest[0] = toUncompressedFloat(src[0], compressionLevel, true);
            dest[1] = toUncompressedFloat(src[1], compressionLevel, true);
            dest[2] = toUncompressedFloat(src[2], compressionLevel, true);
            return dest;
        };

        return function(outSphericalHarmonicsArray, outSphericalHarmonicsDegree, transform,
                        srcFrom, srcTo, destFrom, desiredOutputCompressionLevel) {
            const splatCount = this.splatCount;

            srcFrom = srcFrom || 0;
            srcTo = srcTo || splatCount - 1;
            if (destFrom === undefined) destFrom = srcFrom;

            if (transform && outSphericalHarmonicsDegree >= 1) {
                tempMatrix3.setFromMatrix4(transform);
                set3(sh11, tempMatrix3.elements[4], -tempMatrix3.elements[7], tempMatrix3.elements[1]);
                set3(sh12, -tempMatrix3.elements[5], tempMatrix3.elements[8], -tempMatrix3.elements[2]);
                set3(sh13, tempMatrix3.elements[3], -tempMatrix3.elements[6], tempMatrix3.elements[0]);
            }

            for (let i = srcFrom; i <= srcTo; i++) {

                const sectionIndex = this.globalSplatIndexToSectionMap[i];
                const section = this.sections[sectionIndex];
                outSphericalHarmonicsDegree = Math.min(outSphericalHarmonicsDegree, section.sphericalHarmonicsDegree);
                const outSphericalHarmonicsComponentsCount = getSphericalHarmonicsComponentCountForDegree(outSphericalHarmonicsDegree);

                const localSplatIndex = i - section.splatCountOffset;

                const srcSplatSHBase = section.bytesPerSplat * localSplatIndex +
                                       SplatBuffer.CompressionLevels[this.compressionLevel].SphericalHarmonicsOffsetBytes;

                const dataView = new DataView(this.bufferData, section.dataBase + srcSplatSHBase);

                const shDestBase = (i - srcFrom + destFrom) * outSphericalHarmonicsComponentsCount;

                let compressionLevelForOutputConversion = transform ? 0 : this.compressionLevel;
                let outputConversionFunc = noop;
                if (compressionLevelForOutputConversion !== desiredOutputCompressionLevel) {
                    if (compressionLevelForOutputConversion === 1) {
                        if (desiredOutputCompressionLevel === 0) outputConversionFunc = fromHalfFloat;
                        else if (desiredOutputCompressionLevel == 2) outputConversionFunc = fromHalfFloatToUint8;
                    } else if (compressionLevelForOutputConversion === 0) {
                        if (desiredOutputCompressionLevel === 1) outputConversionFunc = toHalfFloat;
                        else if (desiredOutputCompressionLevel == 2) outputConversionFunc = toUint8;
                    }
                }

                if (outSphericalHarmonicsDegree >= 1) {

                    set3FromArray(shIn1, dataView, 3, 0, this.compressionLevel);
                    set3FromArray(shIn2, dataView, 3, 1, this.compressionLevel);
                    set3FromArray(shIn3, dataView, 3, 2, this.compressionLevel);

                    if (transform) {
                        toUncompressedFloatArray3(shIn1, shIn1, this.compressionLevel);
                        toUncompressedFloatArray3(shIn2, shIn2, this.compressionLevel);
                        toUncompressedFloatArray3(shIn3, shIn3, this.compressionLevel);
                        SplatBuffer.rotateSphericalHarmonics3(shIn1, shIn2, shIn3, sh11, sh12, sh13, shOut1, shOut2, shOut3);
                    } else {
                        copy3(shIn1, shOut1);
                        copy3(shIn2, shOut2);
                        copy3(shIn3, shOut3);
                    }

                    setOutput3(shOut1, outSphericalHarmonicsArray, shDestBase, outputConversionFunc);
                    setOutput3(shOut2, outSphericalHarmonicsArray, shDestBase + 3, outputConversionFunc);
                    setOutput3(shOut3, outSphericalHarmonicsArray, shDestBase + 6, outputConversionFunc);

                    if (outSphericalHarmonicsDegree >= 2) {

                        set3FromArray(shIn1, dataView, 5, 9, this.compressionLevel);
                        set3FromArray(shIn2, dataView, 5, 10, this.compressionLevel);
                        set3FromArray(shIn3, dataView, 5, 11, this.compressionLevel);
                        set3FromArray(shIn4, dataView, 5, 12, this.compressionLevel);
                        set3FromArray(shIn5, dataView, 5, 13, this.compressionLevel);

                        if (transform) {
                            toUncompressedFloatArray3(shIn1, shIn1, this.compressionLevel);
                            toUncompressedFloatArray3(shIn2, shIn2, this.compressionLevel);
                            toUncompressedFloatArray3(shIn3, shIn3, this.compressionLevel);
                            toUncompressedFloatArray3(shIn4, shIn4, this.compressionLevel);
                            toUncompressedFloatArray3(shIn5, shIn5, this.compressionLevel);
                            SplatBuffer.rotateSphericalHarmonics5(shIn1, shIn2, shIn3, shIn4, shIn5,
                                                                  sh11, sh12, sh13, sh21, sh22, sh23, sh24, sh25,
                                                                  shOut1, shOut2, shOut3, shOut4, shOut5);
                        } else {
                            copy3(shIn1, shOut1);
                            copy3(shIn2, shOut2);
                            copy3(shIn3, shOut3);
                            copy3(shIn4, shOut4);
                            copy3(shIn5, shOut5);
                        }

                        setOutput3(shOut1, outSphericalHarmonicsArray, shDestBase + 9, outputConversionFunc);
                        setOutput3(shOut2, outSphericalHarmonicsArray, shDestBase + 12, outputConversionFunc);
                        setOutput3(shOut3, outSphericalHarmonicsArray, shDestBase + 15, outputConversionFunc);
                        setOutput3(shOut4, outSphericalHarmonicsArray, shDestBase + 18, outputConversionFunc);
                        setOutput3(shOut5, outSphericalHarmonicsArray, shDestBase + 21, outputConversionFunc);
                    }
                }
            }
        };

    }();

    static dot3 = (v1, v2, v3, transformRow, outArray) => {
        outArray[0] = outArray[1] = outArray[2] = 0;
        const t0 = transformRow[0];
        const t1 = transformRow[1];
        const t2 = transformRow[2];
        SplatBuffer.addInto3(v1[0] * t0, v1[1] * t0, v1[2] * t0, outArray);
        SplatBuffer.addInto3(v2[0] * t1, v2[1] * t1, v2[2] * t1, outArray);
        SplatBuffer.addInto3(v3[0] * t2, v3[1] * t2, v3[2] * t2, outArray);
    };

    static addInto3 = (val1, val2, val3, destArray) => {
        destArray[0] = destArray[0] + val1;
        destArray[1] = destArray[1] + val2;
        destArray[2] = destArray[2] + val3;
    };

    static dot5 = (v1, v2, v3, v4, v5, transformRow, outArray) => {
        outArray[0] = outArray[1] = outArray[2] = 0;
        const t0 = transformRow[0];
        const t1 = transformRow[1];
        const t2 = transformRow[2];
        const t3 = transformRow[3];
        const t4 = transformRow[4];
        SplatBuffer.addInto3(v1[0] * t0, v1[1] * t0, v1[2] * t0, outArray);
        SplatBuffer.addInto3(v2[0] * t1, v2[1] * t1, v2[2] * t1, outArray);
        SplatBuffer.addInto3(v3[0] * t2, v3[1] * t2, v3[2] * t2, outArray);
        SplatBuffer.addInto3(v4[0] * t3, v4[1] * t3, v4[2] * t3, outArray);
        SplatBuffer.addInto3(v5[0] * t4, v5[1] * t4, v5[2] * t4, outArray);
    };

    static rotateSphericalHarmonics3 = (in1, in2, in3, tsh11, tsh12, tsh13, out1, out2, out3) => {
        SplatBuffer.dot3(in1, in2, in3, tsh11, out1);
        SplatBuffer.dot3(in1, in2, in3, tsh12, out2);
        SplatBuffer.dot3(in1, in2, in3, tsh13, out3);
    };

    static rotateSphericalHarmonics5 = (in1, in2, in3, in4, in5, tsh11, tsh12, tsh13,
                                        tsh21, tsh22, tsh23, tsh24, tsh25, out1, out2, out3, out4, out5) => {

        const kSqrt0104 = Math.sqrt(1.0 / 4.0);
        const kSqrt0304 = Math.sqrt(3.0 / 4.0);
        const kSqrt0103 = Math.sqrt(1.0 / 3.0);
        const kSqrt0403 = Math.sqrt(4.0 / 3.0);
        const kSqrt0112 = Math.sqrt(1.0 / 12.0);

        tsh21[0] = kSqrt0104 * ((tsh13[2] * tsh11[0] + tsh13[0] * tsh11[2]) + (tsh11[2] * tsh13[0] + tsh11[0] * tsh13[2]));
        tsh21[1] = (tsh13[1] * tsh11[0] + tsh11[1] * tsh13[0]);
        tsh21[2] = kSqrt0304 * (tsh13[1] * tsh11[1] + tsh11[1] * tsh13[1]);
        tsh21[3] = (tsh13[1] * tsh11[2] + tsh11[1] * tsh13[2]);
        tsh21[4] = kSqrt0104 * ((tsh13[2] * tsh11[2] - tsh13[0] * tsh11[0]) + (tsh11[2] * tsh13[2] - tsh11[0] * tsh13[0]));
        SplatBuffer.dot5(in1, in2, in3, in4, in5, tsh21, out1);

        tsh22[0] = kSqrt0104 * ((tsh12[2] * tsh11[0] + tsh12[0] * tsh11[2]) + (tsh11[2] * tsh12[0] + tsh11[0] * tsh12[2]));
        tsh22[1] = tsh12[1] * tsh11[0] + tsh11[1] * tsh12[0];
        tsh22[2] = kSqrt0304 * (tsh12[1] * tsh11[1] + tsh11[1] * tsh12[1]);
        tsh22[3] = tsh12[1] * tsh11[2] + tsh11[1] * tsh12[2];
        tsh22[4] = kSqrt0104 * ((tsh12[2] * tsh11[2] - tsh12[0] * tsh11[0]) + (tsh11[2] * tsh12[2] - tsh11[0] * tsh12[0]));
        SplatBuffer.dot5(in1, in2, in3, in4, in5, tsh22, out2);

        tsh23[0] = kSqrt0103 * (tsh12[2] * tsh12[0] + tsh12[0] * tsh12[2]) + -kSqrt0112 *
                   ((tsh13[2] * tsh13[0] + tsh13[0] * tsh13[2]) + (tsh11[2] * tsh11[0] + tsh11[0] * tsh11[2]));
        tsh23[1] = kSqrt0403 * tsh12[1] * tsh12[0] + -kSqrt0103 * (tsh13[1] * tsh13[0] + tsh11[1] * tsh11[0]);
        tsh23[2] = tsh12[1] * tsh12[1] + -kSqrt0104 * (tsh13[1] * tsh13[1] + tsh11[1] * tsh11[1]);
        tsh23[3] = kSqrt0403 * tsh12[1] * tsh12[2] + -kSqrt0103 * (tsh13[1] * tsh13[2] + tsh11[1] * tsh11[2]);
        tsh23[4] = kSqrt0103 * (tsh12[2] * tsh12[2] - tsh12[0] * tsh12[0]) + -kSqrt0112 *
                   ((tsh13[2] * tsh13[2] - tsh13[0] * tsh13[0]) + (tsh11[2] * tsh11[2] - tsh11[0] * tsh11[0]));
        SplatBuffer.dot5(in1, in2, in3, in4, in5, tsh23, out3);

        tsh24[0] = kSqrt0104 * ((tsh12[2] * tsh13[0] + tsh12[0] * tsh13[2]) + (tsh13[2] * tsh12[0] + tsh13[0] * tsh12[2]));
        tsh24[1] = tsh12[1] * tsh13[0] + tsh13[1] * tsh12[0];
        tsh24[2] = kSqrt0304 * (tsh12[1] * tsh13[1] + tsh13[1] * tsh12[1]);
        tsh24[3] = tsh12[1] * tsh13[2] + tsh13[1] * tsh12[2];
        tsh24[4] = kSqrt0104 * ((tsh12[2] * tsh13[2] - tsh12[0] * tsh13[0]) + (tsh13[2] * tsh12[2] - tsh13[0] * tsh12[0]));
        SplatBuffer.dot5(in1, in2, in3, in4, in5, tsh24, out4);

        tsh25[0] = kSqrt0104 * ((tsh13[2] * tsh13[0] + tsh13[0] * tsh13[2]) - (tsh11[2] * tsh11[0] + tsh11[0] * tsh11[2]));
        tsh25[1] = (tsh13[1] * tsh13[0] - tsh11[1] * tsh11[0]);
        tsh25[2] = kSqrt0304 * (tsh13[1] * tsh13[1] - tsh11[1] * tsh11[1]);
        tsh25[3] = (tsh13[1] * tsh13[2] - tsh11[1] * tsh11[2]);
        tsh25[4] = kSqrt0104 * ((tsh13[2] * tsh13[2] - tsh13[0] * tsh13[0]) - (tsh11[2] * tsh11[2] - tsh11[0] * tsh11[0]));
        SplatBuffer.dot5(in1, in2, in3, in4, in5, tsh25, out5);
    };

    static parseHeader(buffer) {
        const headerArrayUint8 = new Uint8Array(buffer, 0, SplatBuffer.HeaderSizeBytes);
        const headerArrayUint16 = new Uint16Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 2);
        const headerArrayUint32 = new Uint32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        const headerArrayFloat32 = new Float32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        const versionMajor = headerArrayUint8[0];
        const versionMinor = headerArrayUint8[1];
        const maxSectionCount = headerArrayUint32[1];
        const sectionCount = headerArrayUint32[2];
        const maxSplatCount = headerArrayUint32[3];
        const splatCount = headerArrayUint32[4];
        const compressionLevel = headerArrayUint16[10];
        const sceneCenter = new THREE.Vector3(headerArrayFloat32[6], headerArrayFloat32[7], headerArrayFloat32[8]);

        return {
            versionMajor,
            versionMinor,
            maxSectionCount,
            sectionCount,
            maxSplatCount,
            splatCount,
            compressionLevel,
            sceneCenter
        };
    }

    static writeHeaderCountsToBuffer(sectionCount, splatCount, buffer) {
        const headerArrayUint32 = new Uint32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        headerArrayUint32[2] = sectionCount;
        headerArrayUint32[4] = splatCount;
    }

    static writeHeaderToBuffer(header, buffer) {
        const headerArrayUint8 = new Uint8Array(buffer, 0, SplatBuffer.HeaderSizeBytes);
        const headerArrayUint16 = new Uint16Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 2);
        const headerArrayUint32 = new Uint32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        const headerArrayFloat32 = new Float32Array(buffer, 0, SplatBuffer.HeaderSizeBytes / 4);
        headerArrayUint8[0] = header.versionMajor;
        headerArrayUint8[1] = header.versionMinor;
        headerArrayUint8[2] = 0; // unused for now
        headerArrayUint8[3] = 0; // unused for now
        headerArrayUint32[1] = header.maxSectionCount;
        headerArrayUint32[2] = header.sectionCount;
        headerArrayUint32[3] = header.maxSplatCount;
        headerArrayUint32[4] = header.splatCount;
        headerArrayUint16[10] = header.compressionLevel;
        headerArrayFloat32[6] = header.sceneCenter.x;
        headerArrayFloat32[7] = header.sceneCenter.y;
        headerArrayFloat32[8] = header.sceneCenter.z;
    }

    static parseSectionHeaders(header, buffer, offset = 0, secLoadedCountsToMax) {
        const compressionLevel = header.compressionLevel;

        const maxSectionCount = header.maxSectionCount;
        const sectionHeaderArrayUint16 = new Uint16Array(buffer, offset, maxSectionCount * SplatBuffer.SectionHeaderSizeBytes / 2);
        const sectionHeaderArrayUint32 = new Uint32Array(buffer, offset, maxSectionCount * SplatBuffer.SectionHeaderSizeBytes / 4);
        const sectionHeaderArrayFloat32 = new Float32Array(buffer, offset, maxSectionCount * SplatBuffer.SectionHeaderSizeBytes / 4);

        const sectionHeaders = [];
        let sectionHeaderBase = 0;
        let sectionHeaderBaseUint16 = sectionHeaderBase / 2;
        let sectionHeaderBaseUint32 = sectionHeaderBase / 4;
        let sectionBase = SplatBuffer.HeaderSizeBytes + header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes;
        let splatCountOffset = 0;
        for (let i = 0; i < maxSectionCount; i++) {
            const maxSplatCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 1];
            const bucketSize = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 2];
            const bucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 3];
            const bucketBlockSize = sectionHeaderArrayFloat32[sectionHeaderBaseUint32 + 4];
            const halfBucketBlockSize = bucketBlockSize / 2.0;
            const bucketStorageSizeBytes = sectionHeaderArrayUint16[sectionHeaderBaseUint16 + 10];
            const compressionScaleRange = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 6] ||
                                          SplatBuffer.CompressionLevels[compressionLevel].ScaleRange;
            const fullBucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 8];
            const partiallyFilledBucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 9];
            const bucketsMetaDataSizeBytes = partiallyFilledBucketCount * 4;
            const bucketsStorageSizeBytes = bucketStorageSizeBytes * bucketCount + bucketsMetaDataSizeBytes;

            const sphericalHarmonicsDegree = sectionHeaderArrayUint16[sectionHeaderBaseUint16 + 20];
            const { bytesPerSplat } = SplatBuffer.calculateComponentStorage(compressionLevel, sphericalHarmonicsDegree);

            const splatDataStorageSizeBytes = bytesPerSplat * maxSplatCount;
            const storageSizeBytes = splatDataStorageSizeBytes + bucketsStorageSizeBytes;
            const sectionHeader = {
                bytesPerSplat: bytesPerSplat,
                splatCountOffset: splatCountOffset,
                splatCount: secLoadedCountsToMax ? maxSplatCount : 0,
                maxSplatCount: maxSplatCount,
                bucketSize: bucketSize,
                bucketCount: bucketCount,
                bucketBlockSize: bucketBlockSize,
                halfBucketBlockSize: halfBucketBlockSize,
                bucketStorageSizeBytes: bucketStorageSizeBytes,
                bucketsStorageSizeBytes: bucketsStorageSizeBytes,
                splatDataStorageSizeBytes: splatDataStorageSizeBytes,
                storageSizeBytes: storageSizeBytes,
                compressionScaleRange: compressionScaleRange,
                compressionScaleFactor: halfBucketBlockSize / compressionScaleRange,
                base: sectionBase,
                bucketsBase: sectionBase + bucketsMetaDataSizeBytes,
                dataBase: sectionBase + bucketsStorageSizeBytes,
                fullBucketCount: fullBucketCount,
                partiallyFilledBucketCount: partiallyFilledBucketCount,
                sphericalHarmonicsDegree: sphericalHarmonicsDegree
            };
            sectionHeaders[i] = sectionHeader;
            sectionBase += storageSizeBytes;
            sectionHeaderBase += SplatBuffer.SectionHeaderSizeBytes;
            sectionHeaderBaseUint16 = sectionHeaderBase / 2;
            sectionHeaderBaseUint32 = sectionHeaderBase / 4;
            splatCountOffset += maxSplatCount;
        }

        return sectionHeaders;
    }


    static writeSectionHeaderToBuffer(sectionHeader, compressionLevel, buffer, offset = 0) {
        const sectionHeadeArrayUint16 = new Uint16Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 2);
        const sectionHeadeArrayUint32 = new Uint32Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 4);
        const sectionHeadeArrayFloat32 = new Float32Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 4);

        sectionHeadeArrayUint32[0] = sectionHeader.splatCount;
        sectionHeadeArrayUint32[1] = sectionHeader.maxSplatCount;
        sectionHeadeArrayUint32[2] = compressionLevel >= 1 ? sectionHeader.bucketSize : 0;
        sectionHeadeArrayUint32[3] = compressionLevel >= 1 ? sectionHeader.bucketCount : 0;
        sectionHeadeArrayFloat32[4] = compressionLevel >= 1 ? sectionHeader.bucketBlockSize : 0.0;
        sectionHeadeArrayUint16[10] = compressionLevel >= 1 ? SplatBuffer.BucketStorageSizeBytes : 0;
        sectionHeadeArrayUint32[6] = compressionLevel >= 1 ? sectionHeader.compressionScaleRange : 0;
        sectionHeadeArrayUint32[7] = sectionHeader.storageSizeBytes;
        sectionHeadeArrayUint32[8] = compressionLevel >= 1 ? sectionHeader.fullBucketCount : 0;
        sectionHeadeArrayUint32[9] = compressionLevel >= 1 ? sectionHeader.partiallyFilledBucketCount : 0;
        sectionHeadeArrayUint16[20] = sectionHeader.sphericalHarmonicsDegree;

    }

    static writeSectionHeaderSplatCountToBuffer(splatCount, buffer, offset = 0) {
        const sectionHeadeArrayUint32 = new Uint32Array(buffer, offset, SplatBuffer.SectionHeaderSizeBytes / 4);
        sectionHeadeArrayUint32[0] = splatCount;
    }

    constructFromBuffer(bufferData, secLoadedCountsToMax) {
        this.bufferData = bufferData;

        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSectionMap = [];

        const header = SplatBuffer.parseHeader(this.bufferData);
        this.versionMajor = header.versionMajor;
        this.versionMinor = header.versionMinor;
        this.maxSectionCount = header.maxSectionCount;
        this.sectionCount = secLoadedCountsToMax ? header.maxSectionCount : 0;
        this.maxSplatCount = header.maxSplatCount;
        this.splatCount = secLoadedCountsToMax ? header.maxSplatCount : 0;
        this.compressionLevel = header.compressionLevel;
        this.sceneCenter = new THREE.Vector3().copy(header.sceneCenter);

        this.sections = SplatBuffer.parseSectionHeaders(header, this.bufferData, SplatBuffer.HeaderSizeBytes, secLoadedCountsToMax);

        this.linkBufferArrays();
        this.buildMaps();
    }

    static calculateComponentStorage(compressionLevel, sphericalHarmonicsDegree) {
        const bytesPerCenter = SplatBuffer.CompressionLevels[compressionLevel].BytesPerCenter;
        const bytesPerScale = SplatBuffer.CompressionLevels[compressionLevel].BytesPerScale;
        const bytesPerRotation = SplatBuffer.CompressionLevels[compressionLevel].BytesPerRotation;
        const bytesPerColor = SplatBuffer.CompressionLevels[compressionLevel].BytesPerColor;
        const sphericalHarmonicsComponentsPerSplat = getSphericalHarmonicsComponentCountForDegree(sphericalHarmonicsDegree);
        const sphericalHarmonicsBytesPerSplat = SplatBuffer.CompressionLevels[compressionLevel].BytesPerSphericalHarmonicsComponent *
                                                sphericalHarmonicsComponentsPerSplat;
        const bytesPerSplat = bytesPerCenter + bytesPerScale + bytesPerRotation +
                              bytesPerColor + sphericalHarmonicsBytesPerSplat;
        return {
            bytesPerCenter,
            bytesPerScale,
            bytesPerRotation,
            bytesPerColor,
            sphericalHarmonicsComponentsPerSplat,
            sphericalHarmonicsBytesPerSplat,
            bytesPerSplat
        };
    }

    linkBufferArrays() {
        for (let i = 0; i < this.maxSectionCount; i++) {
            const section = this.sections[i];
            section.bucketArray = new Float32Array(this.bufferData, section.bucketsBase,
                                                   section.bucketCount * SplatBuffer.BucketStorageSizeFloats);
            if (section.partiallyFilledBucketCount > 0) {
                section.partiallyFilledBucketLengths = new Uint32Array(this.bufferData, section.base,
                                                                       section.partiallyFilledBucketCount);
            }
        }
    }

    buildMaps() {
        let cumulativeSplatCount = 0;
        for (let i = 0; i < this.maxSectionCount; i++) {
            const section = this.sections[i];
            for (let j = 0; j < section.maxSplatCount; j++) {
                const globalSplatIndex = cumulativeSplatCount + j;
                this.globalSplatIndexToLocalSplatIndexMap[globalSplatIndex] = j;
                this.globalSplatIndexToSectionMap[globalSplatIndex] = i;
            }
            cumulativeSplatCount += section.maxSplatCount;
        }
    }

    updateLoadedCounts(newSectionCount, newSplatCount) {
        SplatBuffer.writeHeaderCountsToBuffer(newSectionCount, newSplatCount, this.bufferData);
        this.sectionCount = newSectionCount;
        this.splatCount = newSplatCount;
    }

    updateSectionLoadedCounts(sectionIndex, newSplatCount) {
        const sectionHeaderOffset = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * sectionIndex;
        SplatBuffer.writeSectionHeaderSplatCountToBuffer(newSplatCount, this.bufferData, sectionHeaderOffset);
        this.sections[sectionIndex].splatCount = newSplatCount;
    }

    static generateFromUncompressedSplatArrays(splatArrays, minimumAlpha, compressionLevel,
                                               sceneCenter, blockSize, bucketSize, options = []) {

        const copyBetweenBuffers = (srcBuffer, srcOffset, destBuffer, destOffset, byteCount = 0) => {
            const src = new Uint8Array(srcBuffer, srcOffset);
            const dest = new Uint8Array(destBuffer, destOffset);
            for (let i = 0; i < byteCount; i++) {
                dest[i] = src[i];
            }
        };

        let sphericalHarmonicsDegree = 0;

        for (let sa = 0; sa < splatArrays.length; sa ++) {
            const splatArray = splatArrays[sa];
            if (sa === 0 || splatArray.sphericalHarmonicsDegree < sphericalHarmonicsDegree) {
                if (sa > 0 && splatArray.sphericalHarmonicsDegree !== sphericalHarmonicsDegree) {
                    const msg = 'SplatBuffer::generateFromUncompressedSplatArrays() -> ' +
                                'all splat arrays must have the same spherical harmonics degree.';
                    throw new Error(msg);
                }
                sphericalHarmonicsDegree = splatArray.sphericalHarmonicsDegree;
            }
        }

        const {bytesPerCenter, bytesPerScale, bytesPerRotation, bytesPerColor, sphericalHarmonicsComponentsPerSplat,
              sphericalHarmonicsBytesPerSplat, bytesPerSplat} =
              SplatBuffer.calculateComponentStorage(compressionLevel, sphericalHarmonicsDegree);

        const compressionScaleRange = SplatBuffer.CompressionLevels[compressionLevel].ScaleRange;

        const sectionBuffers = [];
        const sectionHeaderBuffers = [];
        let totalSplatCount = 0;

        const tempRotation = new THREE.Quaternion();

        for (let sa = 0; sa < splatArrays.length; sa ++) {
            const splatArray = splatArrays[sa];

            const sectionOptions = options[sa] || {};

            const sectionBlockSize = (sectionOptions.blockSizeFactor || 1) * (blockSize || SplatBuffer.BucketBlockSize);
            const sectionBucketSize = Math.ceil((sectionOptions.bucketSizeFactor || 1) * (bucketSize || SplatBuffer.BucketSize));

            const validSplats = new UncompressedSplatArray(sphericalHarmonicsDegree);

            for (let i = 0; i < splatArray.splatCount; i++) {
                const targetSplat = splatArray.splats[i];
                let alpha;
                if (targetSplat[UncompressedSplatArray.OFFSET.OPACITY]) {
                    alpha = targetSplat[UncompressedSplatArray.OFFSET.OPACITY];
                } else {
                    alpha = 255;
                }
                if (alpha >= minimumAlpha) {
                    validSplats.addSplat(targetSplat);
                }
            }

            const bucketInfo = SplatBuffer.computeBucketsForUncompressedSplatArray(validSplats, sectionBlockSize, sectionBucketSize);
            const fullBucketCount = bucketInfo.fullBuckets.length;
            const partiallyFullBucketLengths = bucketInfo.partiallyFullBuckets.map((bucket) => bucket.splats.length);
            const partiallyFilledBucketCount = partiallyFullBucketLengths.length;
            const buckets = [...bucketInfo.fullBuckets, ...bucketInfo.partiallyFullBuckets];

            const sectionDataSizeBytes = validSplats.splats.length * bytesPerSplat;
            const bucketMetaDataSizeBytes = partiallyFilledBucketCount * 4;
            const bucketDataBytes = compressionLevel >= 1 ? buckets.length *
                                                            SplatBuffer.BucketStorageSizeBytes + bucketMetaDataSizeBytes : 0;
            const sectionSizeBytes = sectionDataSizeBytes + bucketDataBytes;
            const sectionBuffer = new ArrayBuffer(sectionSizeBytes);

            const blockHalfSize = sectionBlockSize / 2.0;
            const compressionScaleFactor = compressionScaleRange / blockHalfSize;
            const doubleCompressionScaleRange = compressionScaleRange * 2 + 1;

            const tempCenterBuffer = new ArrayBuffer(bytesPerCenter);
            const tempScaleBuffer = new ArrayBuffer(bytesPerScale);
            const tempRotationBuffer = new ArrayBuffer(bytesPerRotation);
            const tempColorBuffer = new ArrayBuffer(bytesPerColor);
            const tempSHBuffer = new ArrayBuffer(sphericalHarmonicsBytesPerSplat);

            const bucketCenter = new THREE.Vector3();
            const bucketCenterDelta = new THREE.Vector3();
            let outSplatCount = 0;
            for (let b = 0; b < buckets.length; b++) {
                const bucket = buckets[b];
                bucketCenter.fromArray(bucket.center);
                for (let i = 0; i < bucket.splats.length; i++) {
                    let row = bucket.splats[i];
                    const targetSplat = validSplats.splats[row];

                    const centerBase = bucketDataBytes + outSplatCount * bytesPerSplat;
                    const scaleBase = centerBase + bytesPerCenter;
                    const rotationBase = scaleBase + bytesPerScale;
                    const colorBase = rotationBase + bytesPerRotation;
                    const sphericalHarmonicsBase = colorBase + bytesPerColor;
                    if (compressionLevel === 0) {
                        const center = new Float32Array(sectionBuffer, centerBase, SplatBuffer.CenterComponentCount);
                        const rot = new Float32Array(sectionBuffer, rotationBase, SplatBuffer.RotationComponentCount);
                        const scale = new Float32Array(sectionBuffer, scaleBase, SplatBuffer.ScaleComponentCount);
                        if (targetSplat[UncompressedSplatArray.OFFSET.SCALE0] !== undefined) {
                            tempRotation.set(targetSplat[UncompressedSplatArray.OFFSET.ROTATION0],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION1],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION2],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION3]);
                            tempRotation.normalize();
                            rot.set([tempRotation.x, tempRotation.y, tempRotation.z, tempRotation.w]);
                            scale.set([targetSplat[UncompressedSplatArray.OFFSET.SCALE0],
                                       targetSplat[UncompressedSplatArray.OFFSET.SCALE1],
                                       targetSplat[UncompressedSplatArray.OFFSET.SCALE2]]);
                        } else {
                            rot.set([1.0, 0.0, 0.0, 0.0]);
                            scale.set([0.01, 0.01, 0.01]);
                        }
                        center.set([targetSplat[UncompressedSplatArray.OFFSET.X],
                                    targetSplat[UncompressedSplatArray.OFFSET.Y],
                                    targetSplat[UncompressedSplatArray.OFFSET.Z]]);
                        if (sphericalHarmonicsDegree > 0) {
                           const shOut = new Float32Array(sectionBuffer, sphericalHarmonicsBase, sphericalHarmonicsComponentsPerSplat);
                           if (sphericalHarmonicsDegree >= 1) {
                                for (let s = 0; s < 9; s++) shOut[s] = targetSplat[UncompressedSplatArray.OFFSET.FRC0 + s];
                                if (sphericalHarmonicsDegree >= 2) {
                                    for (let s = 0; s < 15; s++) shOut[s + 9] = targetSplat[UncompressedSplatArray.OFFSET.FRC9 + s];
                                }
                           }
                        }
                    } else {
                        const center = new Uint16Array(tempCenterBuffer, 0, SplatBuffer.CenterComponentCount);
                        const rot = new Uint16Array(tempRotationBuffer, 0, SplatBuffer.RotationComponentCount);
                        const scale = new Uint16Array(tempScaleBuffer, 0, SplatBuffer.ScaleComponentCount);

                        if (targetSplat[UncompressedSplatArray.OFFSET.SCALE0] !== undefined) {
                            tempRotation.set(targetSplat[UncompressedSplatArray.OFFSET.ROTATION0],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION1],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION2],
                                             targetSplat[UncompressedSplatArray.OFFSET.ROTATION3]);
                            tempRotation.normalize();
                            rot.set([toHalfFloat(tempRotation.x), toHalfFloat(tempRotation.y),
                                     toHalfFloat(tempRotation.z), toHalfFloat(tempRotation.w)]);
                            scale.set([toHalfFloat(targetSplat[UncompressedSplatArray.OFFSET.SCALE0]),
                                       toHalfFloat(targetSplat[UncompressedSplatArray.OFFSET.SCALE1]),
                                       toHalfFloat(targetSplat[UncompressedSplatArray.OFFSET.SCALE2])]);
                        } else {
                            rot.set([toHalfFloat(1.), 0, 0, 0]);
                            scale.set([toHalfFloat(0.01), toHalfFloat(0.01), toHalfFloat(0.01)]);
                        }
                        bucketCenterDelta.set(targetSplat[UncompressedSplatArray.OFFSET.X],
                                              targetSplat[UncompressedSplatArray.OFFSET.Y],
                                              targetSplat[UncompressedSplatArray.OFFSET.Z]).sub(bucketCenter);
                        bucketCenterDelta.x = Math.round(bucketCenterDelta.x * compressionScaleFactor) + compressionScaleRange;
                        bucketCenterDelta.x = clamp(bucketCenterDelta.x, 0, doubleCompressionScaleRange);
                        bucketCenterDelta.y = Math.round(bucketCenterDelta.y * compressionScaleFactor) + compressionScaleRange;
                        bucketCenterDelta.y = clamp(bucketCenterDelta.y, 0, doubleCompressionScaleRange);
                        bucketCenterDelta.z = Math.round(bucketCenterDelta.z * compressionScaleFactor) + compressionScaleRange;
                        bucketCenterDelta.z = clamp(bucketCenterDelta.z, 0, doubleCompressionScaleRange);
                        center.set([bucketCenterDelta.x, bucketCenterDelta.y, bucketCenterDelta.z]);
                        if (sphericalHarmonicsDegree > 0) {
                            const SHArrayType = compressionLevel === 1 ? Uint16Array : Uint8Array;
                            const bytesPerSHComponent = compressionLevel === 1 ? 2 : 1;
                            const shOut = new SHArrayType(tempSHBuffer, 0, sphericalHarmonicsComponentsPerSplat);
                            if (sphericalHarmonicsDegree >= 1) {
                                for (let s = 0; s < 9; s++) {
                                    const srcVal = targetSplat[UncompressedSplatArray.OFFSET.FRC0 + s];
                                    shOut[s] = compressionLevel === 1 ? toHalfFloat(srcVal) : toUint8(srcVal);
                                }
                                const degree1ByteCount = 9 * bytesPerSHComponent;
                                copyBetweenBuffers(shOut.buffer, 0, sectionBuffer, sphericalHarmonicsBase, degree1ByteCount);
                                if (sphericalHarmonicsDegree >= 2) {
                                    for (let s = 0; s < 15; s++) {
                                        const srcVal = targetSplat[UncompressedSplatArray.OFFSET.FRC9 + s];
                                        shOut[s + 9] = compressionLevel === 1 ? toHalfFloat(srcVal) : toUint8(srcVal);
                                    }
                                    const degree2ByteCount = 15 * bytesPerSHComponent;
                                    copyBetweenBuffers(shOut.buffer, degree1ByteCount, sectionBuffer,
                                                       sphericalHarmonicsBase + degree1ByteCount, degree2ByteCount);
                                }
                            }
                        }

                        copyBetweenBuffers(center.buffer, 0, sectionBuffer, centerBase, 6);
                        copyBetweenBuffers(scale.buffer, 0, sectionBuffer, scaleBase, 6);
                        copyBetweenBuffers(rot.buffer, 0, sectionBuffer, rotationBase, 8);
                    }

                    const rgba = new Uint8ClampedArray(tempColorBuffer, 0, 4);

                    if (targetSplat[UncompressedSplatArray.OFFSET.FDC0] !== undefined) {
                        rgba.set([targetSplat[UncompressedSplatArray.OFFSET.FDC0],
                                  targetSplat[UncompressedSplatArray.OFFSET.FDC1],
                                  targetSplat[UncompressedSplatArray.OFFSET.FDC2]]);
                    } else {
                        rgba.set([255, 0, 0]);
                    }
                    if (targetSplat[UncompressedSplatArray.OFFSET.OPACITY] !== undefined) {
                        rgba[3] = targetSplat[UncompressedSplatArray.OFFSET.OPACITY];
                    } else {
                        rgba[3] = 255;
                    }

                    copyBetweenBuffers(rgba.buffer, 0, sectionBuffer, colorBase, 4);

                    outSplatCount++;
                }
            }
            totalSplatCount += outSplatCount;

            if (compressionLevel >= 1) {
                const bucketMetaDataArray = new Uint32Array(sectionBuffer, 0, partiallyFullBucketLengths.length * 4);
                for (let pfb = 0; pfb < partiallyFullBucketLengths.length; pfb ++) {
                    bucketMetaDataArray[pfb] = partiallyFullBucketLengths[pfb];
                }
                const bucketArray = new Float32Array(sectionBuffer, bucketMetaDataSizeBytes,
                                                     buckets.length * SplatBuffer.BucketStorageSizeFloats);
                for (let b = 0; b < buckets.length; b++) {
                    const bucket = buckets[b];
                    const base = b * 3;
                    bucketArray[base] = bucket.center[0];
                    bucketArray[base + 1] = bucket.center[1];
                    bucketArray[base + 2] = bucket.center[2];
                }
            }
            sectionBuffers.push(sectionBuffer);

            const sectionHeaderBuffer = new ArrayBuffer(SplatBuffer.SectionHeaderSizeBytes);
            SplatBuffer.writeSectionHeaderToBuffer({
                maxSplatCount: outSplatCount,
                splatCount: outSplatCount,
                bucketSize: sectionBucketSize,
                bucketCount: buckets.length,
                bucketBlockSize: sectionBlockSize,
                compressionScaleRange: compressionScaleRange,
                storageSizeBytes: sectionSizeBytes,
                fullBucketCount: fullBucketCount,
                partiallyFilledBucketCount: partiallyFilledBucketCount,
                sphericalHarmonicsDegree: sphericalHarmonicsDegree
            }, compressionLevel, sectionHeaderBuffer, 0);
            sectionHeaderBuffers.push(sectionHeaderBuffer);

        }

        let sectionsCumulativeSizeBytes = 0;
        for (let sectionBuffer of sectionBuffers) sectionsCumulativeSizeBytes += sectionBuffer.byteLength;
        const unifiedBufferSize = SplatBuffer.HeaderSizeBytes +
                                  SplatBuffer.SectionHeaderSizeBytes * sectionBuffers.length + sectionsCumulativeSizeBytes;
        const unifiedBuffer = new ArrayBuffer(unifiedBufferSize);

        SplatBuffer.writeHeaderToBuffer({
            versionMajor: 0,
            versionMinor: 1,
            maxSectionCount: sectionBuffers.length,
            sectionCount: sectionBuffers.length,
            maxSplatCount: totalSplatCount,
            splatCount: totalSplatCount,
            compressionLevel: compressionLevel,
            sceneCenter: sceneCenter
        }, unifiedBuffer);

        let currentUnifiedBase = SplatBuffer.HeaderSizeBytes;
        for (let sectionHeaderBuffer of sectionHeaderBuffers) {
            new Uint8Array(unifiedBuffer, currentUnifiedBase, SplatBuffer.SectionHeaderSizeBytes).set(new Uint8Array(sectionHeaderBuffer));
            currentUnifiedBase += SplatBuffer.SectionHeaderSizeBytes;
        }

        for (let sectionBuffer of sectionBuffers) {
            new Uint8Array(unifiedBuffer, currentUnifiedBase, sectionBuffer.byteLength).set(new Uint8Array(sectionBuffer));
            currentUnifiedBase += sectionBuffer.byteLength;
        }

        const splatBuffer = new SplatBuffer(unifiedBuffer);
        return splatBuffer;
    }

    static computeBucketsForUncompressedSplatArray(splatArray, blockSize, bucketSize) {
        let splatCount = splatArray.splatCount;
        const halfBlockSize = blockSize / 2.0;

        const min = new THREE.Vector3();
        const max = new THREE.Vector3();

        for (let i = 0; i < splatCount; i++) {
            const targetSplat = splatArray.splats[i];
            const center = [targetSplat[UncompressedSplatArray.OFFSET.X],
                            targetSplat[UncompressedSplatArray.OFFSET.Y],
                            targetSplat[UncompressedSplatArray.OFFSET.Z]];
            if (i === 0 || center[0] < min.x) min.x = center[0];
            if (i === 0 || center[0] > max.x) max.x = center[0];
            if (i === 0 || center[1] < min.y) min.y = center[1];
            if (i === 0 || center[1] > max.y) max.y = center[1];
            if (i === 0 || center[2] < min.z) min.z = center[2];
            if (i === 0 || center[2] > max.z) max.z = center[2];
        }

        const dimensions = new THREE.Vector3().copy(max).sub(min);
        const yBlocks = Math.ceil(dimensions.y / blockSize);
        const zBlocks = Math.ceil(dimensions.z / blockSize);

        const blockCenter = new THREE.Vector3();
        const fullBuckets = [];
        const partiallyFullBuckets = {};

        for (let i = 0; i < splatCount; i++) {
            const targetSplat = splatArray.splats[i];
            const center = [targetSplat[UncompressedSplatArray.OFFSET.X],
                            targetSplat[UncompressedSplatArray.OFFSET.Y],
                            targetSplat[UncompressedSplatArray.OFFSET.Z]];
            const xBlock = Math.floor((center[0] - min.x) / blockSize);
            const yBlock = Math.floor((center[1] - min.y) / blockSize);
            const zBlock = Math.floor((center[2] - min.z) / blockSize);

            blockCenter.x = xBlock * blockSize + min.x + halfBlockSize;
            blockCenter.y = yBlock * blockSize + min.y + halfBlockSize;
            blockCenter.z = zBlock * blockSize + min.z + halfBlockSize;

            const bucketId = xBlock * (yBlocks * zBlocks) + yBlock * zBlocks + zBlock;
            let bucket = partiallyFullBuckets[bucketId];
            if (!bucket) {
                partiallyFullBuckets[bucketId] = bucket = {
                    'splats': [],
                    'center': blockCenter.toArray()
                };
            }

            bucket.splats.push(i);
            if (bucket.splats.length >= bucketSize) {
                fullBuckets.push(bucket);
                partiallyFullBuckets[bucketId] = null;
            }
        }

        const partiallyFullBucketArray = [];
        for (let bucketId in partiallyFullBuckets) {
            if (partiallyFullBuckets.hasOwnProperty(bucketId)) {
                const bucket = partiallyFullBuckets[bucketId];
                if (bucket) {
                    partiallyFullBucketArray.push(bucket);
                }
            }
        }

        return {
            'fullBuckets': fullBuckets,
            'partiallyFullBuckets': partiallyFullBucketArray,
        };
    }

}

const HeaderMagicBytes = new Uint8Array([112, 108, 121, 10]);
const HeaderEndTokenBytes = new Uint8Array([10, 101, 110, 100, 95, 104, 101, 97, 100, 101, 114, 10]);
const HeaderEndToken = 'end_header';

const DataTypeMap = new Map([
  ['char', Int8Array],
  ['uchar', Uint8Array],
  ['short', Int16Array],
  ['ushort', Uint16Array],
  ['int', Int32Array],
  ['uint', Uint32Array],
  ['float', Float32Array],
  ['double', Float64Array],
]);

const unpackUnorm = (value, bits) => {
  const t = (1 << bits) - 1;
  return (value & t) / t;
};

const unpack111011 = (result, value) => {
  result.x = unpackUnorm(value >>> 21, 11);
  result.y = unpackUnorm(value >>> 11, 10);
  result.z = unpackUnorm(value, 11);
};

const unpack8888 = (result, value) => {
  result.x = unpackUnorm(value >>> 24, 8);
  result.y = unpackUnorm(value >>> 16, 8);
  result.z = unpackUnorm(value >>> 8, 8);
  result.w = unpackUnorm(value, 8);
};

// unpack quaternion with 2,10,10,10 format (largest element, 3x10bit element)
const unpackRot = (result, value) => {
  const norm = 1.0 / (Math.sqrt(2) * 0.5);
  const a = (unpackUnorm(value >>> 20, 10) - 0.5) * norm;
  const b = (unpackUnorm(value >>> 10, 10) - 0.5) * norm;
  const c = (unpackUnorm(value, 10) - 0.5) * norm;
  const m = Math.sqrt(1.0 - (a * a + b * b + c * c));

  switch (value >>> 30) {
    case 0:
      result.set(m, a, b, c);
      break;
    case 1:
      result.set(a, m, b, c);
      break;
    case 2:
      result.set(a, b, m, c);
      break;
    case 3:
      result.set(a, b, c, m);
      break;
  }
};

const lerp = (a, b, t) => {
  return a * (1 - t) + b * t;
};

const getElementPropStorage = (element, name) => {
  return element.properties.find((p) => p.name === name && p.storage)
    ?.storage;
};

class CompressedPlyParser {

  static decodeHeaderText(headerText) {

    let element;
    let chunkElement;
    let vertexElement;

    const headerLines = headerText.split('\n').filter((line) => !line.startsWith('comment '));

    let bytesPerSplat = 0;
    let done = false;
    for (let i = 1; i < headerLines.length; ++i) {
      const words = headerLines[i].split(' ');

      switch (words[0]) {
        case 'format':
          if (words[1] !== 'binary_little_endian') {
            throw new Error('Unsupported ply format');
          }
          break;
        case 'element':
          element = {
            name: words[1],
            count: parseInt(words[2], 10),
            properties: [],
            storageSizeBytes: 0
          };
          if (element.name === 'chunk') chunkElement = element;
          else if (element.name === 'vertex') vertexElement = element;
          break;
        case 'property': {
          if (!DataTypeMap.has(words[1])) {
            throw new Error(
              `Unrecognized property data type '${words[1]}' in ply header`
            );
          }
          const StorageType = DataTypeMap.get(words[1]);
          const storageSizeByes = StorageType.BYTES_PER_ELEMENT * element.count;
          if (element.name === 'vertex') bytesPerSplat += StorageType.BYTES_PER_ELEMENT;
          element.properties.push({
            type: words[1],
            name: words[2],
            storage: null,
            byteSize: StorageType.BYTES_PER_ELEMENT,
            storageSizeByes: storageSizeByes
          });
          element.storageSizeBytes += storageSizeByes;
          break;
        }
        case HeaderEndToken:
          done = true;
        break;
        default:
          throw new Error(
            `Unrecognized header value '${words[0]}' in ply header`
          );
      }
      if (done) break;
    }

    return {
      'chunkElement': chunkElement,
      'vertexElement': vertexElement,
      'bytesPerSplat': bytesPerSplat,
      'headerSizeBytes': headerText.indexOf(HeaderEndToken) + HeaderEndToken.length + 1,
    };
  }

  static decodeHeader(plyBuffer) {

    /**
     * Searches for the first occurrence of a sequence within a buffer.
     * @example
     * find(new Uint8Array([1, 2, 3, 4]), new Uint8Array([3, 4])); // 2
     * @param {Uint8Array} buf - The buffer in which to search.
     * @param {Uint8Array} search - The sequence to search for.
     * @return {number} The index of the first occurrence of the search sequence in the buffer, or -1 if not found.
     */
    const find = (buf, search) => {
      const endIndex = buf.length - search.length;
      let i;
      let j;
      for (i = 0; i <= endIndex; ++i) {
        for (j = 0; j < search.length; ++j) {
          if (buf[i + j] !== search[j]) {
            break;
          }
        }
        if (j === search.length) {
          return i;
        }
      }
      return -1;
    };

    /**
     * Checks if array 'a' starts with the same elements as array 'b'.
     * @example
     * startsWith(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2])); // true
     * @param {Uint8Array} a - The array to check against.
     * @param {Uint8Array} b - The array of elements to look for at the start of 'a'.
     * @return {boolean} - True if 'a' starts with all elements of 'b', otherwise false.
     */
    const startsWith = (a, b) => {
      if (a.length < b.length) {
        return false;
      }

      for (let i = 0; i < b.length; ++i) {
        if (a[i] !== b[i]) {
          return false;
        }
      }

      return true;
    };

    let buf = new Uint8Array(plyBuffer);
    let endHeaderTokenOffset;

    if (buf.length >= HeaderMagicBytes.length && !startsWith(buf, HeaderMagicBytes)) {
      throw new Error('Invalid PLY header');
    }

    endHeaderTokenOffset = find(buf, HeaderEndTokenBytes);
    if (endHeaderTokenOffset === -1) {
      throw new Error('End of PLY header not found');
    }

    const headerText = new TextDecoder('ascii').decode(
      buf.slice(0, endHeaderTokenOffset)
    );

    const {chunkElement, vertexElement, bytesPerSplat} = CompressedPlyParser.decodeHeaderText(headerText);

    return {
      'headerSizeBytes': endHeaderTokenOffset + HeaderEndTokenBytes.length,
      'bytesPerSplat': bytesPerSplat,
      'chunkElement': chunkElement,
      'vertexElement': vertexElement
    };
  }

  static readElementData(element, readBuffer, readOffset, fromIndex, toIndex, propertyFilter = null) {

    let dataView = readBuffer instanceof DataView ? readBuffer : new DataView(readBuffer);

    fromIndex = fromIndex || 0;
    toIndex = toIndex || element.count - 1;
    for (let e = fromIndex; e <= toIndex; ++e) {
      for (let j = 0; j < element.properties.length; ++j) {
        const property = element.properties[j];

        const StorageType = DataTypeMap.get(property.type);
        const requiredStorageSizeBytes = StorageType.BYTES_PER_ELEMENT * element.count;
        if ((!property.storage || property.storage.byteLength < requiredStorageSizeBytes) &&
            (!propertyFilter || propertyFilter(property.name))) {
          property.storage = new StorageType(element.count);
        }

        if (property.storage) {
          switch (property.type) {
            case 'char':
              property.storage[e] = dataView.getInt8(readOffset);
              break;
            case 'uchar':
              property.storage[e] = dataView.getUint8(readOffset);
              break;
            case 'short':
              property.storage[e] = dataView.getInt16(readOffset, true);
              break;
            case 'ushort':
              property.storage[e] = dataView.getUint16(readOffset, true);
              break;
            case 'int':
              property.storage[e] = dataView.getInt32(readOffset, true);
              break;
            case 'uint':
              property.storage[e] = dataView.getUint32(readOffset, true);
              break;
            case 'float':
              property.storage[e] = dataView.getFloat32(readOffset, true);
              break;
            case 'double':
              property.storage[e] = dataView.getFloat64(readOffset, true);
              break;
          }
        }

        readOffset += property.byteSize;
      }
    }

    return readOffset;
  }

  static readPly(plyBuffer, propertyFilter = null) {

    const header = CompressedPlyParser.decodeHeader(plyBuffer);

    let readIndex = CompressedPlyParser.readElementData(header.chunkElement, plyBuffer, header.headerSizeBytes, null, null, propertyFilter);
    CompressedPlyParser.readElementData(header.vertexElement, plyBuffer, readIndex, null, null, propertyFilter);

    return {
      'chunkElement': header.chunkElement,
      'vertexElement': header.vertexElement
    };
  }

  static getElementStorageArrays(chunkElement, vertexElement) {
    const minX = getElementPropStorage(chunkElement, 'min_x');
    const minY = getElementPropStorage(chunkElement, 'min_y');
    const minZ = getElementPropStorage(chunkElement, 'min_z');
    const maxX = getElementPropStorage(chunkElement, 'max_x');
    const maxY = getElementPropStorage(chunkElement, 'max_y');
    const maxZ = getElementPropStorage(chunkElement, 'max_z');
    const minScaleX = getElementPropStorage(chunkElement, 'min_scale_x');
    const minScaleY = getElementPropStorage(chunkElement, 'min_scale_y');
    const minScaleZ = getElementPropStorage(chunkElement, 'min_scale_z');
    const maxScaleX = getElementPropStorage(chunkElement, 'max_scale_x');
    const maxScaleY = getElementPropStorage(chunkElement, 'max_scale_y');
    const maxScaleZ = getElementPropStorage(chunkElement, 'max_scale_z');
    const position = getElementPropStorage(vertexElement, 'packed_position');
    const rotation = getElementPropStorage(vertexElement, 'packed_rotation');
    const scale = getElementPropStorage(vertexElement, 'packed_scale');
    const color = getElementPropStorage(vertexElement, 'packed_color');
    return {
      positionExtremes: {
        minX, maxX,
        minY, maxY,
        minZ, maxZ
      },
      scaleExtremes: {
        minScaleX, maxScaleX, minScaleY,
        maxScaleY, minScaleZ, maxScaleZ
      },
      position,
      rotation,
      scale,
      color
    };
  }

  static decompressSplat = function() {

    const p = new THREE.Vector3();
    const r = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const c = new THREE.Vector4();

    const OFFSET = UncompressedSplatArray.OFFSET;

    return function(index, chunkSplatIndexOffset, positionArray, positionExtremes, scaleArray, scaleExtremes,
                    rotationArray, colorArray, outSplat) {
      outSplat = outSplat || UncompressedSplatArray.createSplat();

      const chunkIndex = Math.floor((chunkSplatIndexOffset + index) / 256);

      unpack111011(p, positionArray[index]);
      unpackRot(r, rotationArray[index]);
      unpack111011(s, scaleArray[index]);
      unpack8888(c, colorArray[index]);

      outSplat[OFFSET.X] = lerp(positionExtremes.minX[chunkIndex], positionExtremes.maxX[chunkIndex], p.x);
      outSplat[OFFSET.Y] = lerp(positionExtremes.minY[chunkIndex], positionExtremes.maxY[chunkIndex], p.y);
      outSplat[OFFSET.Z] = lerp(positionExtremes.minZ[chunkIndex], positionExtremes.maxZ[chunkIndex], p.z);

      outSplat[OFFSET.ROTATION0] = r.x;
      outSplat[OFFSET.ROTATION1] = r.y;
      outSplat[OFFSET.ROTATION2] = r.z;
      outSplat[OFFSET.ROTATION3] = r.w;

      outSplat[OFFSET.SCALE0] = Math.exp(lerp(scaleExtremes.minScaleX[chunkIndex], scaleExtremes.maxScaleX[chunkIndex], s.x));
      outSplat[OFFSET.SCALE1] = Math.exp(lerp(scaleExtremes.minScaleY[chunkIndex], scaleExtremes.maxScaleY[chunkIndex], s.y));
      outSplat[OFFSET.SCALE2] = Math.exp(lerp(scaleExtremes.minScaleZ[chunkIndex], scaleExtremes.maxScaleZ[chunkIndex], s.z));

      outSplat[OFFSET.FDC0] = clamp(Math.floor(c.x * 255), 0, 255);
      outSplat[OFFSET.FDC1] = clamp(Math.floor(c.y * 255), 0, 255);
      outSplat[OFFSET.FDC2] = clamp(Math.floor(c.z * 255), 0, 255);
      outSplat[OFFSET.OPACITY] = clamp(Math.floor(c.w * 255), 0, 255);

      return outSplat;
    };

  }();

  static parseToUncompressedSplatBufferSection(chunkElement, vertexElement, fromIndex, toIndex, chunkSplatIndexOffset,
                                               vertexDataBuffer, veretxReadOffset, outBuffer, outOffset, propertyFilter = null) {

    CompressedPlyParser.readElementData(vertexElement, vertexDataBuffer, veretxReadOffset, fromIndex, toIndex, propertyFilter);

    const outBytesPerCenter = SplatBuffer.CompressionLevels[0].BytesPerCenter;
    const outBytesPerScale = SplatBuffer.CompressionLevels[0].BytesPerScale;
    const outBytesPerRotation = SplatBuffer.CompressionLevels[0].BytesPerRotation;
    const outBytesPerSplat = SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[0].BytesPerSplat;

    const { positionExtremes, scaleExtremes, position, rotation, scale, color } =
      CompressedPlyParser.getElementStorageArrays(chunkElement, vertexElement);

    const OFFSET = UncompressedSplatArray.OFFSET;
    const tempSplat = UncompressedSplatArray.createSplat();

    for (let i = fromIndex; i <= toIndex; ++i) {

      CompressedPlyParser.decompressSplat(i, chunkSplatIndexOffset, position, positionExtremes,
                                          scale, scaleExtremes, rotation, color, tempSplat);

      const outBase = i * outBytesPerSplat + outOffset;
      const outCenter = new Float32Array(outBuffer, outBase, 3);
      const outScale = new Float32Array(outBuffer, outBase + outBytesPerCenter, 3);
      const outRotation = new Float32Array(outBuffer, outBase + outBytesPerCenter + outBytesPerScale, 4);
      const outColor = new Uint8Array(outBuffer, outBase + outBytesPerCenter + outBytesPerScale + outBytesPerRotation, 4);

      outCenter[0] = tempSplat[OFFSET.X];
      outCenter[1] = tempSplat[OFFSET.Y];
      outCenter[2] = tempSplat[OFFSET.Z];

      outScale[0] = tempSplat[OFFSET.SCALE0];
      outScale[1] = tempSplat[OFFSET.SCALE1];
      outScale[2] = tempSplat[OFFSET.SCALE2];

      outRotation[0] = tempSplat[OFFSET.ROTATION0];
      outRotation[1] = tempSplat[OFFSET.ROTATION1];
      outRotation[2] = tempSplat[OFFSET.ROTATION2];
      outRotation[3] = tempSplat[OFFSET.ROTATION3];

      outColor[0] = tempSplat[OFFSET.FDC0];
      outColor[1] = tempSplat[OFFSET.FDC1];
      outColor[2] = tempSplat[OFFSET.FDC2];
      outColor[3] = tempSplat[OFFSET.OPACITY];
    }
  }

  static parseToUncompressedSplatArray(plyBuffer) {
    const { chunkElement, vertexElement } = CompressedPlyParser.readPly(plyBuffer);

    const splatArray = new UncompressedSplatArray();

    const { positionExtremes, scaleExtremes, position, rotation, scale, color } =
      CompressedPlyParser.getElementStorageArrays(chunkElement, vertexElement);

    for (let i = 0; i < vertexElement.count; ++i) {

      splatArray.addDefaultSplat();
      const newSplat = splatArray.getSplat(splatArray.splatCount - 1);

      CompressedPlyParser.decompressSplat(i, 0, position, positionExtremes, scale, scaleExtremes, rotation, color, newSplat);
    }

    const mat = new THREE.Matrix4();
    mat.identity();

    return splatArray;
  }

}

class PlyParser {

    static HeaderEndToken = 'end_header';

    static BaseFields = ['scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
                         'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'red', 'green', 'blue', 'opacity'];

    static SphericalHarmonicsFields = Array.from(Array(45)).map((e, i) => (`f_rest_${i}`));

    static Fields = [[...PlyParser.BaseFields], [...PlyParser.BaseFields, ...PlyParser.SphericalHarmonicsFields]];

    static checkTextForEndHeader(endHeaderTestText) {
        if (endHeaderTestText.includes(PlyParser.HeaderEndToken)) {
            return true;
        }
        return false;
    }

    static checkBufferForEndHeader(buffer, searchOfset, chunkSize, decoder) {
        const endHeaderTestChunk = new Uint8Array(buffer, Math.max(0, searchOfset - chunkSize), chunkSize);
        const endHeaderTestText = decoder.decode(endHeaderTestChunk);
        return PlyParser.checkTextForEndHeader(endHeaderTestText);
    }

    static decodeHeaderText(headerText) {
        const headerLines = headerText.split('\n');

        const prunedLines = [];

        let splatCount = 0;
        let propertyTypes = {};
        let compressed = false;

        for (let i = 0; i < headerLines.length; i++) {
            const line = headerLines[i].trim();
            prunedLines.push(line);
            if (line.startsWith('element chunk') || line.match(/[A-Za-z]*packed_[A-Za-z]*/)) {
                compressed = true;
            } else if (line.startsWith('element vertex')) {
                const splatCountMatch = line.match(/\d+/);
                if (splatCountMatch) {
                    splatCount = parseInt(splatCountMatch[0]);
                }
            } else if (line.startsWith('property')) {
                const propertyMatch = line.match(/(\w+)\s+(\w+)\s+(\w+)/);
                if (propertyMatch) {
                    const propertyType = propertyMatch[2];
                    const propertyName = propertyMatch[3];
                    propertyTypes[propertyName] = propertyType;
                }
            } else if (line === PlyParser.HeaderEndToken) {
                break;
            }
        }

        let bytesPerSplat = 0;
        let fieldOffsets = {};
        const fieldSize = {
            'double': 8,
            'int': 4,
            'uint': 4,
            'float': 4,
            'short': 2,
            'ushort': 2,
            'uchar': 1,
        };

        const fieldNames = [];
        for (let fieldName in propertyTypes) {
            if (propertyTypes.hasOwnProperty(fieldName)) {
                fieldNames.push(fieldName);
                const type = propertyTypes[fieldName];
                fieldOffsets[fieldName] = bytesPerSplat;
                bytesPerSplat += fieldSize[type];
            }
        }

        let sphericalHarmonicsFieldCount = 0;
        let sphericalHarmonicsCoefficientsPerChannel = 0;
        for (let fieldName of fieldNames) {
            if (fieldName.startsWith('f_rest')) sphericalHarmonicsFieldCount++;
        }
        sphericalHarmonicsCoefficientsPerChannel = sphericalHarmonicsFieldCount / 3;
        let sphericalHarmonicsDegree = 0;
        if (sphericalHarmonicsCoefficientsPerChannel >= 3) sphericalHarmonicsDegree = 1;
        if (sphericalHarmonicsCoefficientsPerChannel >= 8) sphericalHarmonicsDegree = 2;

        let sphericalHarmonicsDegree1Fields = [];
        if (sphericalHarmonicsDegree >= 1) {
            for (let rgb = 0; rgb < 3; rgb++) {
                for (let i = 0; i < 3; i++) {
                    sphericalHarmonicsDegree1Fields.push('f_rest_' + (i + sphericalHarmonicsCoefficientsPerChannel * rgb));
                }
            }
        }

        let sphericalHarmonicsDegree2Fields = [];
        if (sphericalHarmonicsDegree >= 2) {
            for (let rgb = 0; rgb < 3; rgb++) {
                for (let i = 0; i < 5; i++) {
                    sphericalHarmonicsDegree2Fields.push('f_rest_' + (i + sphericalHarmonicsCoefficientsPerChannel * rgb + 3));
                }
            }
        }

        return {
            'splatCount': splatCount,
            'propertyTypes': propertyTypes,
            'compressed': compressed,
            'headerText': headerText,
            'headerLines': prunedLines,
            'headerSizeBytes': headerText.indexOf(PlyParser.HeaderEndToken) + PlyParser.HeaderEndToken.length + 1,
            'bytesPerSplat': bytesPerSplat,
            'fieldOffsets': fieldOffsets,
            'sphericalHarmonicsDegree': sphericalHarmonicsDegree,
            'sphericalHarmonicsCoefficientsPerChannel': sphericalHarmonicsCoefficientsPerChannel,
            'sphericalHarmonicsDegree1Fields': sphericalHarmonicsDegree1Fields,
            'sphericalHarmonicsDegree2Fields': sphericalHarmonicsDegree2Fields
        };
    }

    static decodeHeadeFromBuffer(plyBuffer) {
        const decoder = new TextDecoder();
        let headerOffset = 0;
        let headerText = '';
        const readChunkSize = 100;

        while (true) {
            if (headerOffset + readChunkSize >= plyBuffer.byteLength) {
                throw new Error('End of file reached while searching for end of header');
            }
            const headerChunk = new Uint8Array(plyBuffer, headerOffset, readChunkSize);
            headerText += decoder.decode(headerChunk);
            headerOffset += readChunkSize;

            if (PlyParser.checkBufferForEndHeader(plyBuffer, headerOffset, readChunkSize * 2, decoder)) {
                break;
            }
        }

        return PlyParser.decodeHeaderText(headerText);

    }

    static findVertexData(plyBuffer, header) {
        return new DataView(plyBuffer, header.headerSizeBytes);
    }

    static readRawVertexFast(vertexData, offset, fieldOffsets, propertiesToRead, propertyTypes, outVertex) {
        let rawVertex = outVertex || {};
        for (let property of propertiesToRead) {
            const propertyType = propertyTypes[property];
            if (propertyType === 'float') {
                rawVertex[property] = vertexData.getFloat32(offset + fieldOffsets[property], true);
            } else if (propertyType === 'uchar') {
                rawVertex[property] = vertexData.getUint8(offset + fieldOffsets[property]) / 255.0;
            }
        }
    }

    static parseToUncompressedSplatBufferSection(header, fromSplat, toSplat, vertexData, vertexDataOffset,
                                                 toBuffer, toOffset, outSphericalHarmonicsDegree = 0) {
        outSphericalHarmonicsDegree = Math.min(outSphericalHarmonicsDegree, header.sphericalHarmonicsDegree);
        const outBytesPerCenter = SplatBuffer.CompressionLevels[0].BytesPerCenter;
        const outBytesPerScale = SplatBuffer.CompressionLevels[0].BytesPerScale;
        const outBytesPerRotation = SplatBuffer.CompressionLevels[0].BytesPerRotation;
        const outBytesPerColor = SplatBuffer.CompressionLevels[0].BytesPerColor;
        const outBytesPerSplat = SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[outSphericalHarmonicsDegree].BytesPerSplat;

        for (let i = fromSplat; i <= toSplat; i++) {

            const parsedSplat = PlyParser.parseToUncompressedSplat(vertexData, i, header, vertexDataOffset, outSphericalHarmonicsDegree);

            const outBase = i * outBytesPerSplat + toOffset;
            const outCenter = new Float32Array(toBuffer, outBase, 3);
            const outScale = new Float32Array(toBuffer, outBase + outBytesPerCenter, 3);
            const outRotation = new Float32Array(toBuffer, outBase + outBytesPerCenter + outBytesPerScale, 4);
            const outColor = new Uint8Array(toBuffer, outBase + outBytesPerCenter + outBytesPerScale + outBytesPerRotation, 4);

            outCenter[0] = parsedSplat[UncompressedSplatArray.OFFSET.X];
            outCenter[1] = parsedSplat[UncompressedSplatArray.OFFSET.Y];
            outCenter[2] = parsedSplat[UncompressedSplatArray.OFFSET.Z];

            outScale[0] = parsedSplat[UncompressedSplatArray.OFFSET.SCALE0];
            outScale[1] = parsedSplat[UncompressedSplatArray.OFFSET.SCALE1];
            outScale[2] = parsedSplat[UncompressedSplatArray.OFFSET.SCALE2];

            outRotation[0] = parsedSplat[UncompressedSplatArray.OFFSET.ROTATION0];
            outRotation[1] = parsedSplat[UncompressedSplatArray.OFFSET.ROTATION1];
            outRotation[2] = parsedSplat[UncompressedSplatArray.OFFSET.ROTATION2];
            outRotation[3] = parsedSplat[UncompressedSplatArray.OFFSET.ROTATION3];

            outColor[0] = parsedSplat[UncompressedSplatArray.OFFSET.FDC0];
            outColor[1] = parsedSplat[UncompressedSplatArray.OFFSET.FDC1];
            outColor[2] = parsedSplat[UncompressedSplatArray.OFFSET.FDC2];
            outColor[3] = parsedSplat[UncompressedSplatArray.OFFSET.OPACITY];

            if (outSphericalHarmonicsDegree >= 1) {
                const outSphericalHarmonics = new Float32Array(toBuffer, outBase + outBytesPerCenter + outBytesPerScale +
                                                               outBytesPerRotation + outBytesPerColor,
                                                               parsedSplat.sphericalHarmonicsCount);
                for (let i = 0; i <= 8; i++) {
                    outSphericalHarmonics[i] = parsedSplat[UncompressedSplatArray.OFFSET.FRC0 + i];
                }
                if (outSphericalHarmonicsDegree >= 2) {
                    for (let i = 9; i <= 23; i++) {
                        outSphericalHarmonics[i] = parsedSplat[UncompressedSplatArray.OFFSET.FRC0 + i];
                    }
                }
            }
        }
    }

    static parseToUncompressedSplat = function() {

        let rawVertex = {};
        const tempRotation = new THREE.Quaternion();

        return function(vertexData, row, header, vertexDataOffset = 0, outSphericalHarmonicsDegree = 0) {
            outSphericalHarmonicsDegree = Math.min(outSphericalHarmonicsDegree, header.sphericalHarmonicsDegree);
            PlyParser.readRawVertexFast(vertexData, row * header.bytesPerSplat + vertexDataOffset, header.fieldOffsets,
                                        PlyParser.Fields[outSphericalHarmonicsDegree > 0 ? 1 : 0], header.propertyTypes, rawVertex);
            const newSplat = UncompressedSplatArray.createSplat(outSphericalHarmonicsDegree);
            if (rawVertex['scale_0'] !== undefined) {
                newSplat[UncompressedSplatArray.OFFSET.SCALE0] = Math.exp(rawVertex['scale_0']);
                newSplat[UncompressedSplatArray.OFFSET.SCALE1] = Math.exp(rawVertex['scale_1']);
                newSplat[UncompressedSplatArray.OFFSET.SCALE2] = Math.exp(rawVertex['scale_2']);
            } else {
                newSplat[UncompressedSplatArray.OFFSET.SCALE0] = 0.01;
                newSplat[UncompressedSplatArray.OFFSET.SCALE1] = 0.01;
                newSplat[UncompressedSplatArray.OFFSET.SCALE2] = 0.01;
            }

            if (rawVertex['f_dc_0'] !== undefined) {
                const SH_C0 = 0.28209479177387814;
                newSplat[UncompressedSplatArray.OFFSET.FDC0] = (0.5 + SH_C0 * rawVertex['f_dc_0']) * 255;
                newSplat[UncompressedSplatArray.OFFSET.FDC1] = (0.5 + SH_C0 * rawVertex['f_dc_1']) * 255;
                newSplat[UncompressedSplatArray.OFFSET.FDC2] = (0.5 + SH_C0 * rawVertex['f_dc_2']) * 255;
            } else if (rawVertex['red'] !== undefined) {
                newSplat[UncompressedSplatArray.OFFSET.FDC0] = rawVertex['red'] * 255;
                newSplat[UncompressedSplatArray.OFFSET.FDC1] = rawVertex['green'] * 255;
                newSplat[UncompressedSplatArray.OFFSET.FDC2] = rawVertex['blue'] * 255;
            } else {
                newSplat[UncompressedSplatArray.OFFSET.FDC0] = 0;
                newSplat[UncompressedSplatArray.OFFSET.FDC1] = 0;
                newSplat[UncompressedSplatArray.OFFSET.FDC2] = 0;
            }

            if (rawVertex['opacity'] !== undefined) {
                newSplat[UncompressedSplatArray.OFFSET.OPACITY] = (1 / (1 + Math.exp(-rawVertex['opacity']))) * 255;
            }

            newSplat[UncompressedSplatArray.OFFSET.FDC0] = clamp(Math.floor(newSplat[UncompressedSplatArray.OFFSET.FDC0]), 0, 255);
            newSplat[UncompressedSplatArray.OFFSET.FDC1] = clamp(Math.floor(newSplat[UncompressedSplatArray.OFFSET.FDC1]), 0, 255);
            newSplat[UncompressedSplatArray.OFFSET.FDC2] = clamp(Math.floor(newSplat[UncompressedSplatArray.OFFSET.FDC2]), 0, 255);
            newSplat[UncompressedSplatArray.OFFSET.OPACITY] = clamp(Math.floor(newSplat[UncompressedSplatArray.OFFSET.OPACITY]), 0, 255);

            if (outSphericalHarmonicsDegree >= 1) {
                if (rawVertex['f_rest_0'] !== undefined) {
                    for (let i = 0; i < 9; i++) {
                        newSplat[UncompressedSplatArray.OFFSET.FRC0 + i] = rawVertex[header.sphericalHarmonicsDegree1Fields[i]];
                    }
                    if (outSphericalHarmonicsDegree >= 2) {
                        for (let i = 0; i < 15; i++) {
                            newSplat[UncompressedSplatArray.OFFSET.FRC9 + i] = rawVertex[header.sphericalHarmonicsDegree2Fields[i]];
                        }
                    }
                } else {
                    newSplat[UncompressedSplatArray.OFFSET.FRC0] = 0;
                    newSplat[UncompressedSplatArray.OFFSET.FRC1] = 0;
                    newSplat[UncompressedSplatArray.OFFSET.FRC2] = 0;
                }
            }

            tempRotation.set(rawVertex['rot_0'], rawVertex['rot_1'], rawVertex['rot_2'], rawVertex['rot_3']);
            tempRotation.normalize();

            newSplat[UncompressedSplatArray.OFFSET.ROTATION0] = tempRotation.x;
            newSplat[UncompressedSplatArray.OFFSET.ROTATION1] = tempRotation.y;
            newSplat[UncompressedSplatArray.OFFSET.ROTATION2] = tempRotation.z;
            newSplat[UncompressedSplatArray.OFFSET.ROTATION3] = tempRotation.w;

            newSplat[UncompressedSplatArray.OFFSET.X] = rawVertex['x'];
            newSplat[UncompressedSplatArray.OFFSET.Y] = rawVertex['y'];
            newSplat[UncompressedSplatArray.OFFSET.Z] = rawVertex['z'];

            return newSplat;
        };

    }();

    static parseToUncompressedSplatArray(plyBuffer, outSphericalHarmonicsDegree = 0) {

        const header = PlyParser.decodeHeadeFromBuffer(plyBuffer);

        if (header.compressed) {

            return CompressedPlyParser.parseToUncompressedSplatArray(plyBuffer);

        } else {

            const splatCount = header.splatCount;

            const vertexData = PlyParser.findVertexData(plyBuffer, header);

            // TODO: Eventually properly support multiple degree spherical harmonics
            // figure out the SH degree from the number of coefficients
            /* let nRestCoeffs = 0;
            for (const propertyName in header.propertyTypes) {
                if (propertyName.startsWith('f_rest_')) {
                    nRestCoeffs += 1;
                }
            }
            const nCoeffsPerColor = nRestCoeffs / 3;*/

            // const sphericalHarmonicsDegree = Math.sqrt(nCoeffsPerColor + 1) - 1;
            // const sphericalHarmonicsDegree = 0;
            // console.log('Detected degree', sphericalHarmonicsDegree, 'with ', nCoeffsPerColor, 'coefficients per color');

            // figure out the order in which spherical harmonics should be read
            /* const shFeatureOrder = [];
            for (let rgb = 0; rgb < 3; ++rgb) {
                shFeatureOrder.push(`f_dc_${rgb}`);
            }
            for (let i = 0; i < nCoeffsPerColor; ++i) {
                for (let rgb = 0; rgb < 3; ++rgb) {
                    shFeatureOrder.push(`f_rest_${rgb * nCoeffsPerColor + i}`);
                }
            }*/

            const splatArray = new UncompressedSplatArray(outSphericalHarmonicsDegree);

            for (let row = 0; row < splatCount; row++) {
                const newSplat = PlyParser.parseToUncompressedSplat(vertexData, row, header, 0, outSphericalHarmonicsDegree);
                splatArray.addSplat(newSplat);
            }

            return splatArray;
        }
    }

}

class SplatPartitioner {

    constructor(sectionCount, sectionFilters, groupingParameters, partitionGenerator) {
        this.sectionCount = sectionCount;
        this.sectionFilters = sectionFilters;
        this.groupingParameters = groupingParameters;
        this.partitionGenerator = partitionGenerator;
    }

    partitionUncompressedSplatArray(splatArray) {
        let groupingParameters;
        let sectionCount;
        let sectionFilters;
        if (this.partitionGenerator) {
            const results = this.partitionGenerator(splatArray);
            groupingParameters = results.groupingParameters;
            sectionCount = results.sectionCount;
            sectionFilters = results.sectionFilters;
        } else {
            groupingParameters = this.groupingParameters;
            sectionCount = this.sectionCount;
            sectionFilters = this.sectionFilters;
        }

        const newArrays = [];
        for (let s = 0; s < sectionCount; s++) {
            const sectionSplats = new UncompressedSplatArray(splatArray.sphericalHarmonicsDegree);
            const sectionFilter = sectionFilters[s];
            for (let i = 0; i < splatArray.splatCount; i++) {
                if (sectionFilter(i)) {
                    sectionSplats.addSplatFromArray(splatArray, i);
                }
            }
            newArrays.push(sectionSplats);
        }
        return {
            splatArrays: newArrays,
            parameters: groupingParameters
        };
    }

    static getStandardPartitioner(partitionSize = 0, sceneCenter = new THREE.Vector3(),
                                  blockSize = SplatBuffer.BucketBlockSize, bucketSize = SplatBuffer.BucketSize) {
        const partitionGenerator = (splatArray) => {

            if (partitionSize <= 0) partitionSize = splatArray.splatCount;

            const centerA = new THREE.Vector3();
            const centerB = new THREE.Vector3();
            const clampDistance = 0.5;
            const clampPoint = (point) => {
                point.x = Math.floor(point.x / clampDistance) * clampDistance;
                point.y = Math.floor(point.y / clampDistance) * clampDistance;
                point.z = Math.floor(point.z / clampDistance) * clampDistance;
            };
            splatArray.splats.sort((a, b) => {
                centerA.set(a[UncompressedSplatArray.OFFSET.X],
                            a[UncompressedSplatArray.OFFSET.Y],
                            a[UncompressedSplatArray.OFFSET.Z]).sub(sceneCenter);
                clampPoint(centerA);
                const centerADist = centerA.lengthSq();
                centerB.set(b[UncompressedSplatArray.OFFSET.X],
                            b[UncompressedSplatArray.OFFSET.Y],
                            b[UncompressedSplatArray.OFFSET.Z]).sub(sceneCenter);
                clampPoint(centerB);
                const centerBDist = centerB.lengthSq();
                if (centerADist > centerBDist) return 1;
                else return -1;
            });

            const sectionFilters = [];
            const groupingParameters = [];
            partitionSize = Math.min(splatArray.splatCount, partitionSize);
            const patitionCount = Math.ceil(splatArray.splatCount / partitionSize);
            let currentStartSplat = 0;
            for (let i = 0; i < patitionCount; i ++) {
                let startSplat = currentStartSplat;
                sectionFilters.push((splatIndex) => {
                    return splatIndex >= startSplat && splatIndex < startSplat + partitionSize;
                });
                groupingParameters.push({
                    'blocksSize': blockSize,
                    'bucketSize': bucketSize,
                });
                currentStartSplat += partitionSize;
            }
            return {
                'sectionCount': sectionFilters.length,
                sectionFilters,
                groupingParameters
            };
        };
        return new SplatPartitioner(undefined, undefined, undefined, partitionGenerator);
    }
}

class SplatBufferGenerator {

    constructor(splatPartitioner, alphaRemovalThreshold, compressionLevel, sectionSize, sceneCenter, blockSize, bucketSize) {
        this.splatPartitioner = splatPartitioner;
        this.alphaRemovalThreshold = alphaRemovalThreshold;
        this.compressionLevel = compressionLevel;
        this.sectionSize = sectionSize;
        this.sceneCenter = sceneCenter ? new THREE.Vector3().copy(sceneCenter) : undefined;
        this.blockSize = blockSize;
        this.bucketSize = bucketSize;
    }

    generateFromUncompressedSplatArray(splatArray) {
        const partitionResults = this.splatPartitioner.partitionUncompressedSplatArray(splatArray);
        return SplatBuffer.generateFromUncompressedSplatArrays(partitionResults.splatArrays,
                                                               this.alphaRemovalThreshold, this.compressionLevel,
                                                               this.sceneCenter, this.blockSize, this.bucketSize,
                                                               partitionResults.parameters);
    }

    static getStandardGenerator(alphaRemovalThreshold = 1, compressionLevel = 1, sectionSize = 0, sceneCenter = new THREE.Vector3(),
                                blockSize = SplatBuffer.BucketBlockSize, bucketSize = SplatBuffer.BucketSize) {
        const splatPartitioner = SplatPartitioner.getStandardPartitioner(sectionSize, sceneCenter, blockSize, bucketSize);
        return new SplatBufferGenerator(splatPartitioner, alphaRemovalThreshold, compressionLevel,
                                        sectionSize, sceneCenter, blockSize, bucketSize);
    }
}

const LoaderStatus = {
    'Downloading': 0,
    'Processing': 1,
    'Done': 2
};

function storeChunksInBuffer(chunks, buffer) {
    let inBytes = 0;
    for (let chunk of chunks) inBytes += chunk.sizeBytes;

    if (!buffer || buffer.byteLength < inBytes) {
        buffer = new ArrayBuffer(inBytes);
    }

    let offset = 0;
    for (let chunk of chunks) {
        new Uint8Array(buffer, offset, chunk.sizeBytes).set(chunk.data);
        offset += chunk.sizeBytes;
    }

    return buffer;
}

class PlyLoader {

    static loadFromURL(fileName, onProgress, streamLoadData, onStreamedSectionProgress, minimumAlpha, compressionLevel,
                       outSphericalHarmonicsDegree = 0, sectionSize, sceneCenter, blockSize, bucketSize) {

        const streamedSectionSizeBytes = Constants.StreamingSectionSize;
        const splatDataOffsetBytes = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes;
        const sectionCount = 1;

        let streamBufferIn;
        let streamBufferOut;
        let streamedSplatBuffer;
        let compressedPlyHeaderChunksBuffer;
        let maxSplatCount = 0;
        let splatCount = 0;

        let headerLoaded = false;
        let readyToLoadSplatData = false;
        let compressed = false;

        let streamLoadCompleteResolver;
        let streamLoadPromise = new Promise((resolve) => {
            streamLoadCompleteResolver = resolve;
        });

        let numBytesStreamed = 0;
        let numBytesParsed = 0;
        let numBytesDownloaded = 0;
        let headerText = '';
        let header = null;
        let chunks = [];

        const textDecoder = new TextDecoder();

        const localOnProgress = (percent, percentLabel, chunkData) => {
            const loadComplete = percent >= 100;
            if (streamLoadData) {

                if (chunkData) {
                    chunks.push({
                        'data': chunkData,
                        'sizeBytes': chunkData.byteLength,
                        'startBytes': numBytesDownloaded,
                        'endBytes': numBytesDownloaded + chunkData.byteLength
                    });
                    numBytesDownloaded += chunkData.byteLength;
                }

                if (!headerLoaded) {
                    headerText += textDecoder.decode(chunkData);
                    if (PlyParser.checkTextForEndHeader(headerText)) {
                        header = PlyParser.decodeHeaderText(headerText);
                        outSphericalHarmonicsDegree = Math.min(outSphericalHarmonicsDegree, header.sphericalHarmonicsDegree);
                        compressed = header.compressed;

                        if (compressed) {
                            header = CompressedPlyParser.decodeHeaderText(headerText);
                            maxSplatCount = header.vertexElement.count;
                        } else {
                            maxSplatCount = header.splatCount;
                            readyToLoadSplatData = true;
                        }

                        const shDescriptor = SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[outSphericalHarmonicsDegree];
                        const splatBufferSizeBytes = splatDataOffsetBytes + shDescriptor.BytesPerSplat * maxSplatCount;
                        streamBufferOut = new ArrayBuffer(splatBufferSizeBytes);
                        SplatBuffer.writeHeaderToBuffer({
                            versionMajor: SplatBuffer.CurrentMajorVersion,
                            versionMinor: SplatBuffer.CurrentMinorVersion,
                            maxSectionCount: sectionCount,
                            sectionCount: sectionCount,
                            maxSplatCount: maxSplatCount,
                            splatCount: splatCount,
                            compressionLevel: 0,
                            sceneCenter: new THREE.Vector3()
                        }, streamBufferOut);

                        numBytesStreamed = header.headerSizeBytes;
                        numBytesParsed = header.headerSizeBytes;
                        headerLoaded = true;
                    }
                } else if (compressed && !readyToLoadSplatData) {
                    const sizeRequiredForHeaderAndChunks = header.headerSizeBytes + header.chunkElement.storageSizeBytes;
                    compressedPlyHeaderChunksBuffer = storeChunksInBuffer(chunks, compressedPlyHeaderChunksBuffer);
                    if (compressedPlyHeaderChunksBuffer.byteLength >= sizeRequiredForHeaderAndChunks) {
                        CompressedPlyParser.readElementData(header.chunkElement, compressedPlyHeaderChunksBuffer, header.headerSizeBytes);
                        numBytesStreamed = sizeRequiredForHeaderAndChunks;
                        numBytesParsed = sizeRequiredForHeaderAndChunks;
                        readyToLoadSplatData = true;
                    }
                }

                if (headerLoaded && readyToLoadSplatData) {

                    if (chunks.length > 0) {

                        streamBufferIn = storeChunksInBuffer(chunks, streamBufferIn);

                        const bytesLoadedSinceLastStreamedSection = numBytesDownloaded - numBytesStreamed;
                        if (bytesLoadedSinceLastStreamedSection > streamedSectionSizeBytes || loadComplete) {
                            const numBytesToProcess = numBytesDownloaded - numBytesParsed;
                            const addedSplatCount = Math.floor(numBytesToProcess / header.bytesPerSplat);
                            const numBytesToParse = addedSplatCount * header.bytesPerSplat;
                            const numBytesLeftOver = numBytesToProcess - numBytesToParse;
                            const newSplatCount = splatCount + addedSplatCount;
                            const parsedDataViewOffset = numBytesParsed - chunks[0].startBytes;
                            const dataToParse = new DataView(streamBufferIn, parsedDataViewOffset, numBytesToParse);

                            const shDescriptor = SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[outSphericalHarmonicsDegree];
                            const outOffset = splatCount * shDescriptor.BytesPerSplat + splatDataOffsetBytes;

                            if (compressed) {
                                CompressedPlyParser.parseToUncompressedSplatBufferSection(header.chunkElement, header.vertexElement, 0,
                                                                                          addedSplatCount - 1, splatCount,
                                                                                          dataToParse, 0, streamBufferOut, outOffset);
                            } else {
                                PlyParser.parseToUncompressedSplatBufferSection(header, 0, addedSplatCount - 1, dataToParse, 0,
                                                                                streamBufferOut, outOffset, outSphericalHarmonicsDegree);
                            }

                            splatCount = newSplatCount;
                            if (!streamedSplatBuffer) {
                                SplatBuffer.writeSectionHeaderToBuffer({
                                    maxSplatCount: maxSplatCount,
                                    splatCount: splatCount,
                                    bucketSize: 0,
                                    bucketCount: 0,
                                    bucketBlockSize: 0,
                                    compressionScaleRange: 0,
                                    storageSizeBytes: 0,
                                    fullBucketCount: 0,
                                    partiallyFilledBucketCount: 0,
                                    sphericalHarmonicsDegree: outSphericalHarmonicsDegree
                                }, 0, streamBufferOut, SplatBuffer.HeaderSizeBytes);
                                streamedSplatBuffer = new SplatBuffer(streamBufferOut, false);
                            }
                            streamedSplatBuffer.updateLoadedCounts(1, splatCount);
                            onStreamedSectionProgress(streamedSplatBuffer, loadComplete);
                            numBytesStreamed += streamedSectionSizeBytes;
                            numBytesParsed += numBytesToParse;

                            if (numBytesLeftOver === 0) {
                                chunks = [];
                            } else {
                                let keepChunks = [];
                                let keepSize = 0;
                                for (let i = chunks.length - 1; i >= 0; i--) {
                                    const chunk = chunks[i];
                                    keepSize += chunk.sizeBytes;
                                    keepChunks.unshift(chunk);
                                    if (keepSize >= numBytesLeftOver) break;
                                }
                                chunks = keepChunks;
                            }
                        }
                    }

                    if (loadComplete) {
                        streamLoadCompleteResolver(streamedSplatBuffer);
                    }
                }

            }
            if (onProgress) onProgress(percent, percentLabel, LoaderStatus.Downloading);
        };

        return fetchWithProgress(fileName, localOnProgress, !streamLoadData).then((plyFileData) => {
            if (onProgress) onProgress(0, '0%', LoaderStatus.Processing);
            const loadPromise = streamLoadData ? streamLoadPromise :
                                PlyLoader.loadFromFileData(plyFileData, minimumAlpha, compressionLevel, outSphericalHarmonicsDegree,
                                                           sectionSize, sceneCenter, blockSize, bucketSize);
            return loadPromise.then((splatBuffer) => {
                if (onProgress) onProgress(100, '100%', LoaderStatus.Done);
                return splatBuffer;
            });
        });
    }

    static loadFromFileData(plyFileData, minimumAlpha, compressionLevel, outSphericalHarmonicsDegree = 0,
                            sectionSize, sceneCenter, blockSize, bucketSize) {
        return delayedExecute(() => {
            return PlyParser.parseToUncompressedSplatArray(plyFileData, outSphericalHarmonicsDegree);
        })
        .then((splatArray) => {
            const splatBufferGenerator = SplatBufferGenerator.getStandardGenerator(minimumAlpha, compressionLevel, sectionSize,
                                                                                   sceneCenter, blockSize, bucketSize);
            return splatBufferGenerator.generateFromUncompressedSplatArray(splatArray);
        });
    }
}

class SplatParser {

    static RowSizeBytes = 32;
    static CenterSizeBytes = 12;
    static ScaleSizeBytes = 12;
    static RotationSizeBytes = 4;
    static ColorSizeBytes = 4;

    static parseToUncompressedSplatBufferSection(fromSplat, toSplat, fromBuffer, fromOffset, toBuffer, toOffset) {

        const outBytesPerCenter = SplatBuffer.CompressionLevels[0].BytesPerCenter;
        const outBytesPerScale = SplatBuffer.CompressionLevels[0].BytesPerScale;
        const outBytesPerRotation = SplatBuffer.CompressionLevels[0].BytesPerRotation;
        const outBytesPerSplat = SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[0].BytesPerSplat;

        for (let i = fromSplat; i <= toSplat; i++) {
            const inBase = i * SplatParser.RowSizeBytes + fromOffset;
            const inCenter = new Float32Array(fromBuffer, inBase, 3);
            const inScale = new Float32Array(fromBuffer, inBase + SplatParser.CenterSizeBytes, 3);
            const inColor = new Uint8Array(fromBuffer, inBase + SplatParser.CenterSizeBytes + SplatParser.ScaleSizeBytes, 4);
            const inRotation = new Uint8Array(fromBuffer, inBase + SplatParser.CenterSizeBytes + SplatParser.ScaleSizeBytes +
                                              SplatParser.RotationSizeBytes, 4);

            const quat = new THREE.Quaternion((inRotation[1] - 128) / 128, (inRotation[2] - 128) / 128,
                                              (inRotation[3] - 128) / 128, (inRotation[0] - 128) / 128);
            quat.normalize();

            const outBase = i * outBytesPerSplat + toOffset;
            const outCenter = new Float32Array(toBuffer, outBase, 3);
            const outScale = new Float32Array(toBuffer, outBase + outBytesPerCenter, 3);
            const outRotation = new Float32Array(toBuffer, outBase + outBytesPerCenter + outBytesPerScale, 4);
            const outColor = new Uint8Array(toBuffer, outBase + outBytesPerCenter + outBytesPerScale + outBytesPerRotation, 4);

            outCenter[0] = inCenter[0];
            outCenter[1] = inCenter[1];
            outCenter[2] = inCenter[2];

            outScale[0] = inScale[0];
            outScale[1] = inScale[1];
            outScale[2] = inScale[2];

            outRotation[0] = quat.w;
            outRotation[1] = quat.x;
            outRotation[2] = quat.y;
            outRotation[3] = quat.z;

            outColor[0] = inColor[0];
            outColor[1] = inColor[1];
            outColor[2] = inColor[2];
            outColor[3] = inColor[3];
        }
    }

    static parseStandardSplatToUncompressedSplatArray(inBuffer) {
        // Standard .splat row layout:
        // XYZ - Position (Float32)
        // XYZ - Scale (Float32)
        // RGBA - colors (uint8)
        // IJKL - quaternion/rot (uint8)

        const splatCount = inBuffer.byteLength / SplatParser.RowSizeBytes;

        const splatArray = new UncompressedSplatArray();

        for (let i = 0; i < splatCount; i++) {
            const inBase = i * SplatParser.RowSizeBytes;
            const inCenter = new Float32Array(inBuffer, inBase, 3);
            const inScale = new Float32Array(inBuffer, inBase + SplatParser.CenterSizeBytes, 3);
            const inColor = new Uint8Array(inBuffer, inBase + SplatParser.CenterSizeBytes + SplatParser.ScaleSizeBytes, 4);
            const inRotation = new Uint8Array(inBuffer, inBase + SplatParser.CenterSizeBytes +
                                              SplatParser.ScaleSizeBytes + SplatParser.ColorSizeBytes, 4);

            const quat = new THREE.Quaternion((inRotation[1] - 128) / 128, (inRotation[2] - 128) / 128,
                                              (inRotation[3] - 128) / 128, (inRotation[0] - 128) / 128);
            quat.normalize();

            splatArray.addSplatFromComonents(inCenter[0], inCenter[1], inCenter[2], inScale[0], inScale[1], inScale[2],
                                             quat.w, quat.x, quat.y, quat.z, inColor[0], inColor[1], inColor[2], inColor[3]);
        }

        return splatArray;
    }

}

class SplatLoader {

    static loadFromURL(fileName, onProgress, streamLoadData, onStreamedSectionProgress, minimumAlpha, compressionLevel,
                       optimizeSplatData, sectionSize, sceneCenter, blockSize, bucketSize) {

        const splatDataOffsetBytes = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes;
        const streamSectionSizeBytes = Constants.StreamingSectionSize;
        const sectionCount = 1;

        let streamBufferIn;
        let streamBufferOut;
        let streamSplatBuffer;
        let maxSplatCount = 0;
        let splatCount = 0;

        let streamLoadCompleteResolver;
        let streamLoadPromise = new Promise((resolve) => {
            streamLoadCompleteResolver = resolve;
        });

        let numBytesStreamed = 0;
        let numBytesLoaded = 0;
        let chunks = [];

        const localOnProgress = (percent, percentStr, chunk, fileSize) => {
            const loadComplete = percent >= 100;
            if (!fileSize) streamLoadData = false;
            if (streamLoadData) {
                if (!streamBufferIn) {
                    maxSplatCount = fileSize / SplatParser.RowSizeBytes;
                    streamBufferIn = new ArrayBuffer(fileSize);
                    const bytesPerSplat = SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[0].BytesPerSplat;
                    const splatBufferSizeBytes = splatDataOffsetBytes + bytesPerSplat * maxSplatCount;
                    streamBufferOut = new ArrayBuffer(splatBufferSizeBytes);
                    SplatBuffer.writeHeaderToBuffer({
                        versionMajor: SplatBuffer.CurrentMajorVersion,
                        versionMinor: SplatBuffer.CurrentMinorVersion,
                        maxSectionCount: sectionCount,
                        sectionCount: sectionCount,
                        maxSplatCount: maxSplatCount,
                        splatCount: splatCount,
                        compressionLevel: 0,
                        sceneCenter: new THREE.Vector3()
                    }, streamBufferOut);
                }

                if (chunk) {
                    chunks.push(chunk);
                    new Uint8Array(streamBufferIn, numBytesLoaded, chunk.byteLength).set(new Uint8Array(chunk));
                    numBytesLoaded += chunk.byteLength;

                    const bytesLoadedSinceLastSection = numBytesLoaded - numBytesStreamed;
                    if (bytesLoadedSinceLastSection > streamSectionSizeBytes || loadComplete) {
                        const bytesToUpdate = loadComplete ? bytesLoadedSinceLastSection : streamSectionSizeBytes;
                        const addedSplatCount = bytesToUpdate / SplatParser.RowSizeBytes;
                        const newSplatCount = splatCount + addedSplatCount;
                        SplatParser.parseToUncompressedSplatBufferSection(splatCount, newSplatCount - 1, streamBufferIn, 0,
                                                                          streamBufferOut, splatDataOffsetBytes);
                        splatCount = newSplatCount;
                        if (!streamSplatBuffer) {
                            SplatBuffer.writeSectionHeaderToBuffer({
                                maxSplatCount: maxSplatCount,
                                splatCount: splatCount,
                                bucketSize: 0,
                                bucketCount: 0,
                                bucketBlockSize: 0,
                                compressionScaleRange: 0,
                                storageSizeBytes: 0,
                                fullBucketCount: 0,
                                partiallyFilledBucketCount: 0
                            }, 0, streamBufferOut, SplatBuffer.HeaderSizeBytes);
                            streamSplatBuffer = new SplatBuffer(streamBufferOut, false);
                        }
                        streamSplatBuffer.updateLoadedCounts(1, splatCount);
                        onStreamedSectionProgress(streamSplatBuffer, loadComplete);
                        numBytesStreamed += streamSectionSizeBytes;
                    }
                }
                if (loadComplete) {
                    streamLoadCompleteResolver(streamSplatBuffer);
                }
            }
            if (onProgress) onProgress(percent, percentStr, LoaderStatus.Downloading);
            return streamLoadData;
        };

        return fetchWithProgress(fileName, localOnProgress, true).then((fullBuffer) => {
            if (onProgress) onProgress(0, '0%', LoaderStatus.Processing);
            const loadPromise = streamLoadData ? streamLoadPromise :
                SplatLoader.loadFromFileData(fullBuffer, minimumAlpha, compressionLevel, optimizeSplatData,
                                             sectionSize, sceneCenter, blockSize, bucketSize);
            return loadPromise.then((splatBuffer) => {
                if (onProgress) onProgress(100, '100%', LoaderStatus.Done);
                return splatBuffer;
            });
        });
    }

    static loadFromFileData(splatFileData, minimumAlpha, compressionLevel, optimizeSplatData,
                            sectionSize, sceneCenter, blockSize, bucketSize) {
        return delayedExecute(() => {
            const splatArray = SplatParser.parseStandardSplatToUncompressedSplatArray(splatFileData);
            if (optimizeSplatData) {
                const splatBufferGenerator = SplatBufferGenerator.getStandardGenerator(minimumAlpha, compressionLevel,
                                                                                       sectionSize, sceneCenter, blockSize,
                                                                                       bucketSize);
                return splatBufferGenerator.generateFromUncompressedSplatArray(splatArray);
            } else {
                return SplatBuffer.generateFromUncompressedSplatArrays([splatArray], minimumAlpha, 0, new THREE.Vector3());
            }
        });
    }

}

class KSplatLoader {

   static checkVersion(buffer) {
        const minVersionMajor = SplatBuffer.CurrentMajorVersion;
        const minVersionMinor = SplatBuffer.CurrentMinorVersion;
        const header = SplatBuffer.parseHeader(buffer);
        if (header.versionMajor === minVersionMajor &&
            header.versionMinor >= minVersionMinor ||
            header.versionMajor > minVersionMajor) {
           return true;
        } else {
            throw new Error(`KSplat version not supported: v${header.versionMajor}.${header.versionMinor}. ` +
                            `Minimum required: v${minVersionMajor}.${minVersionMinor}`);
        }
    };

    static loadFromURL(fileName, onProgress, streamLoadData, onSectionBuilt) {
        let streamBuffer;
        let streamSplatBuffer;

        let headerBuffer;
        let header;
        let headerLoaded = false;
        let headerLoading = false;

        let sectionHeadersBuffer;
        let sectionHeaders = [];
        let sectionHeadersLoaded = false;
        let sectionHeadersLoading = false;

        let numBytesLoaded = 0;
        let numBytesStreamed = 0;
        let streamSectionSizeBytes = Constants.StreamingSectionSize;
        let totalBytesToDownload = 0;

        let loadComplete = false;

        let chunks = [];

        let streamLoadCompleteResolver;
        let streamLoadPromise = new Promise((resolve) => {
            streamLoadCompleteResolver = resolve;
        });

        const checkAndLoadHeader = () => {
            if (!headerLoaded && !headerLoading && numBytesLoaded >= SplatBuffer.HeaderSizeBytes) {
                headerLoading = true;
                const headerAssemblyPromise = new Blob(chunks).arrayBuffer();
                headerAssemblyPromise.then((bufferData) => {
                    headerBuffer = new ArrayBuffer(SplatBuffer.HeaderSizeBytes);
                    new Uint8Array(headerBuffer).set(new Uint8Array(bufferData, 0, SplatBuffer.HeaderSizeBytes));
                    KSplatLoader.checkVersion(headerBuffer);
                    headerLoading = false;
                    headerLoaded = true;
                    header = SplatBuffer.parseHeader(headerBuffer);
                    window.setTimeout(() => {
                        checkAndLoadSectionHeaders();
                    }, 1);
                });
            }
        };

        let queuedCheckAndLoadSectionsCount = 0;
        const queueCheckAndLoadSections = () => {
            if (queuedCheckAndLoadSectionsCount === 0) {
                queuedCheckAndLoadSectionsCount++;
                window.setTimeout(() => {
                    queuedCheckAndLoadSectionsCount--;
                    checkAndLoadSections(true);
                }, 1);
            }
        };

        const checkAndLoadSectionHeaders = () => {
            const performLoad = () => {
                sectionHeadersLoading = true;
                const sectionHeadersAssemblyPromise = new Blob(chunks).arrayBuffer();
                sectionHeadersAssemblyPromise.then((bufferData) => {
                    sectionHeadersLoading = false;
                    sectionHeadersLoaded = true;
                    sectionHeadersBuffer = new ArrayBuffer(header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes);
                    new Uint8Array(sectionHeadersBuffer).set(new Uint8Array(bufferData, SplatBuffer.HeaderSizeBytes,
                                                                            header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes));
                    sectionHeaders = SplatBuffer.parseSectionHeaders(header, sectionHeadersBuffer, 0, false);
                    let totalSectionStorageStorageByes = 0;
                    for (let i = 0; i < header.maxSectionCount; i++) {
                        totalSectionStorageStorageByes += sectionHeaders[i].storageSizeBytes;
                    }
                    const totalStorageSizeBytes = SplatBuffer.HeaderSizeBytes + header.maxSectionCount *
                                                  SplatBuffer.SectionHeaderSizeBytes + totalSectionStorageStorageByes;
                    if (!streamBuffer) {
                        streamBuffer = new ArrayBuffer(totalStorageSizeBytes);
                        let offset = 0;
                        for (let i = 0; i < chunks.length; i++) {
                            const chunk = chunks[i];
                            new Uint8Array(streamBuffer, offset, chunk.byteLength).set(new Uint8Array(chunk));
                            offset += chunk.byteLength;
                        }
                    }

                    totalBytesToDownload = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount;
                    for (let i = 0; i <= sectionHeaders.length && i < header.maxSectionCount; i++) {
                        totalBytesToDownload += sectionHeaders[i].storageSizeBytes;
                    }

                    queueCheckAndLoadSections();
                });
            };

            if (!sectionHeadersLoading && !sectionHeadersLoaded && headerLoaded &&
                numBytesLoaded >= SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount) {
                performLoad();
            }
        };

        const checkAndLoadSections = () => {
            if (sectionHeadersLoaded) {

                if (loadComplete) return;

                loadComplete = numBytesLoaded >= totalBytesToDownload;

                const bytesLoadedSinceLastSection = numBytesLoaded - numBytesStreamed;
                if (bytesLoadedSinceLastSection > streamSectionSizeBytes || loadComplete) {

                    numBytesStreamed = numBytesLoaded;

                    if (!streamSplatBuffer) streamSplatBuffer = new SplatBuffer(streamBuffer, false);

                    const baseDataOffset = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount;
                    let sectionBase = 0;
                    let reachedSections = 0;
                    let loadedSplatCount = 0;
                    for (let i = 0; i < header.maxSectionCount; i++) {
                        const sectionHeader = sectionHeaders[i];
                        const bucketsDataOffset = sectionBase + sectionHeader.partiallyFilledBucketCount * 4 +
                                                  sectionHeader.bucketStorageSizeBytes * sectionHeader.bucketCount;
                        const bytesRequiredToReachSectionSplatData = baseDataOffset + bucketsDataOffset;
                        if (numBytesLoaded >= bytesRequiredToReachSectionSplatData) {
                            reachedSections++;
                            const bytesPastSSectionSplatDataStart = numBytesLoaded - bytesRequiredToReachSectionSplatData;
                            const baseDescriptor = SplatBuffer.CompressionLevels[header.compressionLevel];
                            const shDesc = baseDescriptor.SphericalHarmonicsDegrees[sectionHeader.sphericalHarmonicsDegree];
                            const bytesPerSplat = shDesc.BytesPerSplat;
                            let loadedSplatsForSection = Math.floor(bytesPastSSectionSplatDataStart / bytesPerSplat);
                            loadedSplatsForSection = Math.min(loadedSplatsForSection, sectionHeader.maxSplatCount);
                            loadedSplatCount += loadedSplatsForSection;
                            streamSplatBuffer.updateLoadedCounts(reachedSections, loadedSplatCount);
                            streamSplatBuffer.updateSectionLoadedCounts(i, loadedSplatsForSection);
                        } else {
                            break;
                        }
                        sectionBase += sectionHeader.storageSizeBytes;
                    }

                    onSectionBuilt(streamSplatBuffer, loadComplete);

                    if (loadComplete) {
                        streamLoadCompleteResolver(streamSplatBuffer);
                    }
                }
            }
        };

        const localOnProgress = (percent, percentStr, chunk) => {
            if (chunk) {
                chunks.push(chunk);
                if (streamBuffer) {
                    new Uint8Array(streamBuffer, numBytesLoaded, chunk.byteLength).set(new Uint8Array(chunk));
                }
                numBytesLoaded += chunk.byteLength;
            }
            if (streamLoadData) {
                checkAndLoadHeader();
                checkAndLoadSectionHeaders();
                checkAndLoadSections();
            }
            if (onProgress) onProgress(percent, percentStr, LoaderStatus.Downloading);
        };

        return fetchWithProgress(fileName, localOnProgress, !streamLoadData).then((fullBuffer) => {
            if (onProgress) onProgress(0, '0%', LoaderStatus.Processing);
            const loadPromise = streamLoadData ? streamLoadPromise : KSplatLoader.loadFromFileData(fullBuffer);
            return loadPromise.then((splatBuffer) => {
                if (onProgress) onProgress(100, '100%', LoaderStatus.Done);
                return splatBuffer;
            });
        });
    }

    static loadFromFileData(fileData) {
        return delayedExecute(() => {
            KSplatLoader.checkVersion(fileData);
            return new SplatBuffer(fileData);
        });
    }

    static downloadFile = function() {

        let downLoadLink;

        return function(splatBuffer, fileName) {
            const blob = new Blob([splatBuffer.bufferData], {
                type: 'application/octet-stream',
            });

            if (!downLoadLink) {
                downLoadLink = document.createElement('a');
                document.body.appendChild(downLoadLink);
            }
            downLoadLink.download = fileName;
            downLoadLink.href = URL.createObjectURL(blob);
            downLoadLink.click();
        };

    }();

}

const SceneFormat = {
    'Splat': 0,
    'KSplat': 1,
    'Ply': 2
};

const sceneFormatFromPath = (path) => {
    if (path.endsWith('.ply')) return SceneFormat.Ply;
    else if (path.endsWith('.splat')) return SceneFormat.Splat;
    else if (path.endsWith('.ksplat')) return SceneFormat.KSplat;
    return null;
};

var Utils = /*#__PURE__*/Object.freeze({
    __proto__: null,
    sceneFormatFromPath: sceneFormatFromPath
});

/*
Copyright © 2010-2024 three.js authors & Mark Kellogg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
*/


// OrbitControls performs orbiting, dollying (zooming), and panning.
// Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
//
//    Orbit - left mouse / touch: one-finger move
//    Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
//    Pan - right mouse, or left mouse + ctrl/meta/shiftKey, or arrow keys / touch: two-finger move

const _changeEvent = { type: 'change' };
const _startEvent = { type: 'start' };
const _endEvent = { type: 'end' };
const _ray = new Ray$1();
const _plane = new Plane();
const TILT_LIMIT = Math.cos( 70 * MathUtils.DEG2RAD );

class OrbitControls extends EventDispatcher {

    constructor( object, domElement ) {

        super();

        this.object = object;
        this.domElement = domElement;
        this.domElement.style.touchAction = 'none'; // disable touch scroll

        // Set to false to disable this control
        this.enabled = true;

        // "target" sets the location of focus, where the object orbits around
        this.target = new Vector3();

        // How far you can dolly in and out ( PerspectiveCamera only )
        this.minDistance = 0;
        this.maxDistance = Infinity;

        // How far you can zoom in and out ( OrthographicCamera only )
        this.minZoom = 0;
        this.maxZoom = Infinity;

        // How far you can orbit vertically, upper and lower limits.
        // Range is 0 to Math.PI radians.
        this.minPolarAngle = 0; // radians
        this.maxPolarAngle = Math.PI; // radians

        // How far you can orbit horizontally, upper and lower limits.
        // If set, the interval [min, max] must be a sub-interval of [- 2 PI, 2 PI], with ( max - min < 2 PI )
        this.minAzimuthAngle = - Infinity; // radians
        this.maxAzimuthAngle = Infinity; // radians

        // Set to true to enable damping (inertia)
        // If damping is enabled, you must call controls.update() in your animation loop
        this.enableDamping = false;
        this.dampingFactor = 0.05;

        // This option actually enables dollying in and out; left as "zoom" for backwards compatibility.
        // Set to false to disable zooming
        this.enableZoom = true;
        this.zoomSpeed = 1.0;

        // Set to false to disable rotating
        this.enableRotate = true;
        this.rotateSpeed = 1.0;

        // Set to false to disable panning
        this.enablePan = true;
        this.panSpeed = 1.0;
        this.screenSpacePanning = true; // if false, pan orthogonal to world-space direction camera.up
        this.keyPanSpeed = 7.0; // pixels moved per arrow key push
        this.zoomToCursor = false;

        // Set to true to automatically rotate around the target
        // If auto-rotate is enabled, you must call controls.update() in your animation loop
        this.autoRotate = false;
        this.autoRotateSpeed = 2.0; // 30 seconds per orbit when fps is 60

        // The four arrow keys
        this.keys = { LEFT: 'KeyA', UP: 'KeyW', RIGHT: 'KeyD', BOTTOM: 'KeyS' };

        // Mouse buttons
        this.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };

        // Touch fingers
        this.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

        // for reset
        this.target0 = this.target.clone();
        this.position0 = this.object.position.clone();
        this.zoom0 = this.object.zoom;

        // the target DOM element for key events
        this._domElementKeyEvents = null;

        //
        // public methods
        //

        this.getPolarAngle = function() {

            return spherical.phi;

        };

        this.getAzimuthalAngle = function() {

            return spherical.theta;

        };

        this.getDistance = function() {

            return this.object.position.distanceTo( this.target );

        };

        this.listenToKeyEvents = function( domElement ) {

            domElement.addEventListener( 'keydown', onKeyDown );
            this._domElementKeyEvents = domElement;

        };

        this.stopListenToKeyEvents = function() {

            this._domElementKeyEvents.removeEventListener( 'keydown', onKeyDown );
            this._domElementKeyEvents = null;

        };

        this.saveState = function() {

            scope.target0.copy( scope.target );
            scope.position0.copy( scope.object.position );
            scope.zoom0 = scope.object.zoom;

        };

        this.reset = function() {

            scope.target.copy( scope.target0 );
            scope.object.position.copy( scope.position0 );
            scope.object.zoom = scope.zoom0;
            this.clearDampedRotation();
            this.clearDampedPan();

            scope.object.updateProjectionMatrix();
            scope.dispatchEvent( _changeEvent );

            scope.update();

            state = STATE.NONE;

        };

        this.clearDampedRotation = function() {
            sphericalDelta.theta = 0.0;
            sphericalDelta.phi = 0.0;
        };

        this.clearDampedPan = function() {
            panOffset.set(0, 0, 0);
        };

        // this method is exposed, but perhaps it would be better if we can make it private...
        this.update = function() {

            const offset = new Vector3();

            // so camera.up is the orbit axis
            const quat = new Quaternion().setFromUnitVectors( object.up, new Vector3( 0, 1, 0 ) );
            const quatInverse = quat.clone().invert();

            const lastPosition = new Vector3();
            const lastQuaternion = new Quaternion();
            const lastTargetPosition = new Vector3();

            const twoPI = 2 * Math.PI;

            return function update() {

                quat.setFromUnitVectors( object.up, new Vector3( 0, 1, 0 ) );
                quatInverse.copy(quat).invert();

                const position = scope.object.position;

                offset.copy( position ).sub( scope.target );

                // rotate offset to "y-axis-is-up" space
                offset.applyQuaternion( quat );

                // angle from z-axis around y-axis
                spherical.setFromVector3( offset );

                if ( scope.autoRotate && state === STATE.NONE ) {

                    rotateLeft( getAutoRotationAngle() );

                }

                if ( scope.enableDamping ) {

                    spherical.theta += sphericalDelta.theta * scope.dampingFactor;
                    spherical.phi += sphericalDelta.phi * scope.dampingFactor;

                } else {

                    spherical.theta += sphericalDelta.theta;
                    spherical.phi += sphericalDelta.phi;

                }

                // restrict theta to be between desired limits

                let min = scope.minAzimuthAngle;
                let max = scope.maxAzimuthAngle;

                if ( isFinite( min ) && isFinite( max ) ) {

                    if ( min < - Math.PI ) min += twoPI; else if ( min > Math.PI ) min -= twoPI;

                    if ( max < - Math.PI ) max += twoPI; else if ( max > Math.PI ) max -= twoPI;

                    if ( min <= max ) {

                        spherical.theta = Math.max( min, Math.min( max, spherical.theta ) );

                    } else {

                        spherical.theta = ( spherical.theta > ( min + max ) / 2 ) ?
                            Math.max( min, spherical.theta ) :
                            Math.min( max, spherical.theta );

                    }

                }

                // restrict phi to be between desired limits
                spherical.phi = Math.max( scope.minPolarAngle, Math.min( scope.maxPolarAngle, spherical.phi ) );

                spherical.makeSafe();


                // move target to panned location

                if ( scope.enableDamping === true ) {

                    scope.target.addScaledVector( panOffset, scope.dampingFactor );

                } else {

                    scope.target.add( panOffset );

                }

                // adjust the camera position based on zoom only if we're not zooming to the cursor or if it's an ortho camera
                // we adjust zoom later in these cases
                if ( scope.zoomToCursor && performCursorZoom || scope.object.isOrthographicCamera ) {

                    spherical.radius = clampDistance( spherical.radius );

                } else {

                    spherical.radius = clampDistance( spherical.radius * scale );

                }


                offset.setFromSpherical( spherical );

                // rotate offset back to "camera-up-vector-is-up" space
                offset.applyQuaternion( quatInverse );

                position.copy( scope.target ).add( offset );

                scope.object.lookAt( scope.target );

                if ( scope.enableDamping === true ) {

                    sphericalDelta.theta *= ( 1 - scope.dampingFactor );
                    sphericalDelta.phi *= ( 1 - scope.dampingFactor );

                    panOffset.multiplyScalar( 1 - scope.dampingFactor );

                } else {

                    sphericalDelta.set( 0, 0, 0 );

                    panOffset.set( 0, 0, 0 );

                }

                // adjust camera position
                let zoomChanged = false;
                if ( scope.zoomToCursor && performCursorZoom ) {

                    let newRadius = null;
                    if ( scope.object.isPerspectiveCamera ) {

                        // move the camera down the pointer ray
                        // this method avoids floating point error
                        const prevRadius = offset.length();
                        newRadius = clampDistance( prevRadius * scale );

                        const radiusDelta = prevRadius - newRadius;
                        scope.object.position.addScaledVector( dollyDirection, radiusDelta );
                        scope.object.updateMatrixWorld();

                    } else if ( scope.object.isOrthographicCamera ) {

                        // adjust the ortho camera position based on zoom changes
                        const mouseBefore = new Vector3( mouse.x, mouse.y, 0 );
                        mouseBefore.unproject( scope.object );

                        scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom / scale ) );
                        scope.object.updateProjectionMatrix();
                        zoomChanged = true;

                        const mouseAfter = new Vector3( mouse.x, mouse.y, 0 );
                        mouseAfter.unproject( scope.object );

                        scope.object.position.sub( mouseAfter ).add( mouseBefore );
                        scope.object.updateMatrixWorld();

                        newRadius = offset.length();

                    } else {

                        console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled.' );
                        scope.zoomToCursor = false;

                    }

                    // handle the placement of the target
                    if ( newRadius !== null ) {

                        if ( this.screenSpacePanning ) {

                            // position the orbit target in front of the new camera position
                            scope.target.set( 0, 0, - 1 )
                                .transformDirection( scope.object.matrix )
                                .multiplyScalar( newRadius )
                                .add( scope.object.position );

                        } else {

                            // get the ray and translation plane to compute target
                            _ray.origin.copy( scope.object.position );
                            _ray.direction.set( 0, 0, - 1 ).transformDirection( scope.object.matrix );

                            // if the camera is 20 degrees above the horizon then don't adjust the focus target to avoid
                            // extremely large values
                            if ( Math.abs( scope.object.up.dot( _ray.direction ) ) < TILT_LIMIT ) {

                                object.lookAt( scope.target );

                            } else {

                                _plane.setFromNormalAndCoplanarPoint( scope.object.up, scope.target );
                                _ray.intersectPlane( _plane, scope.target );

                            }

                        }

                    }

                } else if ( scope.object.isOrthographicCamera ) {

                    scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom / scale ) );
                    scope.object.updateProjectionMatrix();
                    zoomChanged = true;

                }

                scale = 1;
                performCursorZoom = false;

                // update condition is:
                // min(camera displacement, camera rotation in radians)^2 > EPS
                // using small-angle approximation cos(x/2) = 1 - x^2 / 8

                if ( zoomChanged ||
                    lastPosition.distanceToSquared( scope.object.position ) > EPS ||
                    8 * ( 1 - lastQuaternion.dot( scope.object.quaternion ) ) > EPS ||
                    lastTargetPosition.distanceToSquared( scope.target ) > 0 ) {

                    scope.dispatchEvent( _changeEvent );

                    lastPosition.copy( scope.object.position );
                    lastQuaternion.copy( scope.object.quaternion );
                    lastTargetPosition.copy( scope.target );

                    zoomChanged = false;

                    return true;

                }

                return false;

            };

        }();

        this.dispose = function() {

            scope.domElement.removeEventListener( 'contextmenu', onContextMenu );

            scope.domElement.removeEventListener( 'pointerdown', onPointerDown );
            scope.domElement.removeEventListener( 'pointercancel', onPointerUp );
            scope.domElement.removeEventListener( 'wheel', onMouseWheel );

            scope.domElement.removeEventListener( 'pointermove', onPointerMove );
            scope.domElement.removeEventListener( 'pointerup', onPointerUp );


            if ( scope._domElementKeyEvents !== null ) {

                scope._domElementKeyEvents.removeEventListener( 'keydown', onKeyDown );
                scope._domElementKeyEvents = null;

            }

        };

        //
        // internals
        //

        const scope = this;

        const STATE = {
            NONE: - 1,
            ROTATE: 0,
            DOLLY: 1,
            PAN: 2,
            TOUCH_ROTATE: 3,
            TOUCH_PAN: 4,
            TOUCH_DOLLY_PAN: 5,
            TOUCH_DOLLY_ROTATE: 6
        };

        let state = STATE.NONE;

        const EPS = 0.000001;

        // current position in spherical coordinates
        const spherical = new Spherical();
        const sphericalDelta = new Spherical();

        let scale = 1;
        const panOffset = new Vector3();

        const rotateStart = new Vector2();
        const rotateEnd = new Vector2();
        const rotateDelta = new Vector2();

        const panStart = new Vector2();
        const panEnd = new Vector2();
        const panDelta = new Vector2();

        const dollyStart = new Vector2();
        const dollyEnd = new Vector2();
        const dollyDelta = new Vector2();

        const dollyDirection = new Vector3();
        const mouse = new Vector2();
        let performCursorZoom = false;

        const pointers = [];
        const pointerPositions = {};

        function getAutoRotationAngle() {

            return 2 * Math.PI / 60 / 60 * scope.autoRotateSpeed;

        }

        function getZoomScale() {

            return Math.pow( 0.95, scope.zoomSpeed );

        }

        function rotateLeft( angle ) {

            sphericalDelta.theta -= angle;

        }

        function rotateUp( angle ) {

            sphericalDelta.phi -= angle;

        }

        const panLeft = function() {

            const v = new Vector3();

            return function panLeft( distance, objectMatrix ) {

                v.setFromMatrixColumn( objectMatrix, 0 ); // get X column of objectMatrix
                v.multiplyScalar( - distance );

                panOffset.add( v );

            };

        }();

        const panUp = function() {

            const v = new Vector3();

            return function panUp( distance, objectMatrix ) {

                if ( scope.screenSpacePanning === true ) {

                    v.setFromMatrixColumn( objectMatrix, 1 );

                } else {

                    v.setFromMatrixColumn( objectMatrix, 0 );
                    v.crossVectors( scope.object.up, v );

                }

                v.multiplyScalar( distance );

                panOffset.add( v );

            };

        }();

        // deltaX and deltaY are in pixels; right and down are positive
        const pan = function() {

            const offset = new Vector3();

            return function pan( deltaX, deltaY ) {

                const element = scope.domElement;

                if ( scope.object.isPerspectiveCamera ) {

                    // perspective
                    const position = scope.object.position;
                    offset.copy( position ).sub( scope.target );
                    let targetDistance = offset.length();

                    // half of the fov is center to top of screen
                    targetDistance *= Math.tan( ( scope.object.fov / 2 ) * Math.PI / 180.0 );

                    // we use only clientHeight here so aspect ratio does not distort speed
                    panLeft( 2 * deltaX * targetDistance / element.clientHeight, scope.object.matrix );
                    panUp( 2 * deltaY * targetDistance / element.clientHeight, scope.object.matrix );

                } else if ( scope.object.isOrthographicCamera ) {

                    // orthographic
                    panLeft( deltaX * ( scope.object.right - scope.object.left ) /
                                        scope.object.zoom / element.clientWidth, scope.object.matrix );
                    panUp( deltaY * ( scope.object.top - scope.object.bottom ) / scope.object.zoom /
                                      element.clientHeight, scope.object.matrix );

                } else {

                    // camera neither orthographic nor perspective
                    console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - pan disabled.' );
                    scope.enablePan = false;

                }

            };

        }();

        function dollyOut( dollyScale ) {

            if ( scope.object.isPerspectiveCamera || scope.object.isOrthographicCamera ) {

                scale /= dollyScale;

            } else {

                console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
                scope.enableZoom = false;

            }

        }

        function dollyIn( dollyScale ) {

            if ( scope.object.isPerspectiveCamera || scope.object.isOrthographicCamera ) {

                scale *= dollyScale;

            } else {

                console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
                scope.enableZoom = false;

            }

        }

        function updateMouseParameters( event ) {

            if ( ! scope.zoomToCursor ) {

                return;

            }

            performCursorZoom = true;

            const rect = scope.domElement.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const w = rect.width;
            const h = rect.height;

            mouse.x = ( x / w ) * 2 - 1;
            mouse.y = - ( y / h ) * 2 + 1;

            dollyDirection.set( mouse.x, mouse.y, 1 ).unproject( object ).sub( object.position ).normalize();

        }

        function clampDistance( dist ) {

            return Math.max( scope.minDistance, Math.min( scope.maxDistance, dist ) );

        }

        //
        // event callbacks - update the object state
        //

        function handleMouseDownRotate( event ) {

            rotateStart.set( event.clientX, event.clientY );

        }

        function handleMouseDownDolly( event ) {

            updateMouseParameters( event );
            dollyStart.set( event.clientX, event.clientY );

        }

        function handleMouseDownPan( event ) {

            panStart.set( event.clientX, event.clientY );

        }

        function handleMouseMoveRotate( event ) {

            rotateEnd.set( event.clientX, event.clientY );

            rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );

            const element = scope.domElement;

            rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight ); // yes, height

            rotateUp( 2 * Math.PI * rotateDelta.y / element.clientHeight );

            rotateStart.copy( rotateEnd );

            scope.update();

        }

        function handleMouseMoveDolly( event ) {

            dollyEnd.set( event.clientX, event.clientY );

            dollyDelta.subVectors( dollyEnd, dollyStart );

            if ( dollyDelta.y > 0 ) {

                dollyOut( getZoomScale() );

            } else if ( dollyDelta.y < 0 ) {

                dollyIn( getZoomScale() );

            }

            dollyStart.copy( dollyEnd );

            scope.update();

        }

        function handleMouseMovePan( event ) {

            panEnd.set( event.clientX, event.clientY );

            panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );

            pan( panDelta.x, panDelta.y );

            panStart.copy( panEnd );

            scope.update();

        }

        function handleMouseWheel( event ) {

            updateMouseParameters( event );

            if ( event.deltaY < 0 ) {

                dollyIn( getZoomScale() );

            } else if ( event.deltaY > 0 ) {

                dollyOut( getZoomScale() );

            }

            scope.update();

        }

        function handleKeyDown( event ) {

            let needsUpdate = false;

            switch ( event.code ) {

                case scope.keys.UP:

                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

                        rotateUp( 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

                    } else {

                        pan( 0, scope.keyPanSpeed );

                    }

                    needsUpdate = true;
                    break;

                case scope.keys.BOTTOM:

                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

                        rotateUp( - 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

                    } else {

                        pan( 0, - scope.keyPanSpeed );

                    }

                    needsUpdate = true;
                    break;

                case scope.keys.LEFT:

                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

                        rotateLeft( 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

                    } else {

                        pan( scope.keyPanSpeed, 0 );

                    }

                    needsUpdate = true;
                    break;

                case scope.keys.RIGHT:

                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

                        rotateLeft( - 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

                    } else {

                        pan( - scope.keyPanSpeed, 0 );

                    }

                    needsUpdate = true;
                    break;

            }

            if ( needsUpdate ) {

                // prevent the browser from scrolling on cursor keys
                event.preventDefault();

                scope.update();

            }


        }

        function handleTouchStartRotate() {

            if ( pointers.length === 1 ) {

                rotateStart.set( pointers[0].pageX, pointers[0].pageY );

            } else {

                const x = 0.5 * ( pointers[0].pageX + pointers[1].pageX );
                const y = 0.5 * ( pointers[0].pageY + pointers[1].pageY );

                rotateStart.set( x, y );

            }

        }

        function handleTouchStartPan() {

            if ( pointers.length === 1 ) {

                panStart.set( pointers[0].pageX, pointers[0].pageY );

            } else {

                const x = 0.5 * ( pointers[0].pageX + pointers[1].pageX );
                const y = 0.5 * ( pointers[0].pageY + pointers[1].pageY );

                panStart.set( x, y );

            }

        }

        function handleTouchStartDolly() {

            const dx = pointers[0].pageX - pointers[1].pageX;
            const dy = pointers[0].pageY - pointers[1].pageY;

            const distance = Math.sqrt( dx * dx + dy * dy );

            dollyStart.set( 0, distance );

        }

        function handleTouchStartDollyPan() {

            if ( scope.enableZoom ) handleTouchStartDolly();

            if ( scope.enablePan ) handleTouchStartPan();

        }

        function handleTouchStartDollyRotate() {

            if ( scope.enableZoom ) handleTouchStartDolly();

            if ( scope.enableRotate ) handleTouchStartRotate();

        }

        function handleTouchMoveRotate( event ) {

            if ( pointers.length == 1 ) {

                rotateEnd.set( event.pageX, event.pageY );

            } else {

                const position = getSecondPointerPosition( event );

                const x = 0.5 * ( event.pageX + position.x );
                const y = 0.5 * ( event.pageY + position.y );

                rotateEnd.set( x, y );

            }

            rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );

            const element = scope.domElement;

            rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight ); // yes, height

            rotateUp( 2 * Math.PI * rotateDelta.y / element.clientHeight );

            rotateStart.copy( rotateEnd );

        }

        function handleTouchMovePan( event ) {

            if ( pointers.length === 1 ) {

                panEnd.set( event.pageX, event.pageY );

            } else {

                const position = getSecondPointerPosition( event );

                const x = 0.5 * ( event.pageX + position.x );
                const y = 0.5 * ( event.pageY + position.y );

                panEnd.set( x, y );

            }

            panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );

            pan( panDelta.x, panDelta.y );

            panStart.copy( panEnd );

        }

        function handleTouchMoveDolly( event ) {

            const position = getSecondPointerPosition( event );

            const dx = event.pageX - position.x;
            const dy = event.pageY - position.y;

            const distance = Math.sqrt( dx * dx + dy * dy );

            dollyEnd.set( 0, distance );

            dollyDelta.set( 0, Math.pow( dollyEnd.y / dollyStart.y, scope.zoomSpeed ) );

            dollyOut( dollyDelta.y );

            dollyStart.copy( dollyEnd );

        }

        function handleTouchMoveDollyPan( event ) {

            if ( scope.enableZoom ) handleTouchMoveDolly( event );

            if ( scope.enablePan ) handleTouchMovePan( event );

        }

        function handleTouchMoveDollyRotate( event ) {

            if ( scope.enableZoom ) handleTouchMoveDolly( event );

            if ( scope.enableRotate ) handleTouchMoveRotate( event );

        }

        //
        // event handlers - FSM: listen for events and reset state
        //

        function onPointerDown( event ) {

            if ( scope.enabled === false ) return;

            if ( pointers.length === 0 ) {

                scope.domElement.setPointerCapture( event.pointerId );

                scope.domElement.addEventListener( 'pointermove', onPointerMove );
                scope.domElement.addEventListener( 'pointerup', onPointerUp );

            }

            //

            addPointer( event );

            if ( event.pointerType === 'touch' ) {

                onTouchStart( event );

            } else {

                onMouseDown( event );

            }

        }

        function onPointerMove( event ) {

            if ( scope.enabled === false ) return;

            if ( event.pointerType === 'touch' ) {

                onTouchMove( event );

            } else {

                onMouseMove( event );

            }

        }

        function onPointerUp( event ) {

            removePointer( event );

            if ( pointers.length === 0 ) {

                scope.domElement.releasePointerCapture( event.pointerId );

                scope.domElement.removeEventListener( 'pointermove', onPointerMove );
                scope.domElement.removeEventListener( 'pointerup', onPointerUp );

            }

            scope.dispatchEvent( _endEvent );

            state = STATE.NONE;

        }

        function onMouseDown( event ) {

            let mouseAction;

            switch ( event.button ) {

                case 0:

                    mouseAction = scope.mouseButtons.LEFT;
                    break;

                case 1:

                    mouseAction = scope.mouseButtons.MIDDLE;
                    break;

                case 2:

                    mouseAction = scope.mouseButtons.RIGHT;
                    break;

                default:

                    mouseAction = - 1;

            }

            switch ( mouseAction ) {

                case MOUSE.DOLLY:

                    if ( scope.enableZoom === false ) return;

                    handleMouseDownDolly( event );

                    state = STATE.DOLLY;

                    break;

                case MOUSE.ROTATE:

                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

                        if ( scope.enablePan === false ) return;

                        handleMouseDownPan( event );

                        state = STATE.PAN;

                    } else {

                        if ( scope.enableRotate === false ) return;

                        handleMouseDownRotate( event );

                        state = STATE.ROTATE;

                    }

                    break;

                case MOUSE.PAN:

                    if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

                        if ( scope.enableRotate === false ) return;

                        handleMouseDownRotate( event );

                        state = STATE.ROTATE;

                    } else {

                        if ( scope.enablePan === false ) return;

                        handleMouseDownPan( event );

                        state = STATE.PAN;

                    }

                    break;

                default:

                    state = STATE.NONE;

            }

            if ( state !== STATE.NONE ) {

                scope.dispatchEvent( _startEvent );

            }

        }

        function onMouseMove( event ) {

            switch ( state ) {

                case STATE.ROTATE:

                    if ( scope.enableRotate === false ) return;

                    handleMouseMoveRotate( event );

                    break;

                case STATE.DOLLY:

                    if ( scope.enableZoom === false ) return;

                    handleMouseMoveDolly( event );

                    break;

                case STATE.PAN:

                    if ( scope.enablePan === false ) return;

                    handleMouseMovePan( event );

                    break;

            }

        }

        function onMouseWheel( event ) {

            if ( scope.enabled === false || scope.enableZoom === false || state !== STATE.NONE ) return;

            event.preventDefault();

            scope.dispatchEvent( _startEvent );

            handleMouseWheel( event );

            scope.dispatchEvent( _endEvent );

        }

        function onKeyDown( event ) {

            if ( scope.enabled === false || scope.enablePan === false ) return;

            handleKeyDown( event );

        }

        function onTouchStart( event ) {

            trackPointer( event );

            switch ( pointers.length ) {

                case 1:

                    switch ( scope.touches.ONE ) {

                        case TOUCH.ROTATE:

                            if ( scope.enableRotate === false ) return;

                            handleTouchStartRotate();

                            state = STATE.TOUCH_ROTATE;

                            break;

                        case TOUCH.PAN:

                            if ( scope.enablePan === false ) return;

                            handleTouchStartPan();

                            state = STATE.TOUCH_PAN;

                            break;

                        default:

                            state = STATE.NONE;

                    }

                    break;

                case 2:

                    switch ( scope.touches.TWO ) {

                        case TOUCH.DOLLY_PAN:

                            if ( scope.enableZoom === false && scope.enablePan === false ) return;

                            handleTouchStartDollyPan();

                            state = STATE.TOUCH_DOLLY_PAN;

                            break;

                        case TOUCH.DOLLY_ROTATE:

                            if ( scope.enableZoom === false && scope.enableRotate === false ) return;

                            handleTouchStartDollyRotate();

                            state = STATE.TOUCH_DOLLY_ROTATE;

                            break;

                        default:

                            state = STATE.NONE;

                    }

                    break;

                default:

                    state = STATE.NONE;

            }

            if ( state !== STATE.NONE ) {

                scope.dispatchEvent( _startEvent );

            }

        }

        function onTouchMove( event ) {

            trackPointer( event );

            switch ( state ) {

                case STATE.TOUCH_ROTATE:

                    if ( scope.enableRotate === false ) return;

                    handleTouchMoveRotate( event );

                    scope.update();

                    break;

                case STATE.TOUCH_PAN:

                    if ( scope.enablePan === false ) return;

                    handleTouchMovePan( event );

                    scope.update();

                    break;

                case STATE.TOUCH_DOLLY_PAN:

                    if ( scope.enableZoom === false && scope.enablePan === false ) return;

                    handleTouchMoveDollyPan( event );

                    scope.update();

                    break;

                case STATE.TOUCH_DOLLY_ROTATE:

                    if ( scope.enableZoom === false && scope.enableRotate === false ) return;

                    handleTouchMoveDollyRotate( event );

                    scope.update();

                    break;

                default:

                    state = STATE.NONE;

            }

        }

        function onContextMenu( event ) {

            if ( scope.enabled === false ) return;

            event.preventDefault();

        }

        function addPointer( event ) {

            pointers.push( event );

        }

        function removePointer( event ) {

            delete pointerPositions[event.pointerId];

            for ( let i = 0; i < pointers.length; i ++ ) {

                if ( pointers[i].pointerId == event.pointerId ) {

                    pointers.splice( i, 1 );
                    return;

                }

            }

        }

        function trackPointer( event ) {

            let position = pointerPositions[event.pointerId];

            if ( position === undefined ) {

                position = new Vector2();
                pointerPositions[event.pointerId] = position;

            }

            position.set( event.pageX, event.pageY );

        }

        function getSecondPointerPosition( event ) {

            const pointer = ( event.pointerId === pointers[0].pointerId ) ? pointers[1] : pointers[0];

            return pointerPositions[pointer.pointerId];

        }

        //

        scope.domElement.addEventListener( 'contextmenu', onContextMenu );

        scope.domElement.addEventListener( 'pointerdown', onPointerDown );
        scope.domElement.addEventListener( 'pointercancel', onPointerUp );
        scope.domElement.addEventListener( 'wheel', onMouseWheel, { passive: false } );

        // force an update at start

        this.update();

    }

}

const fadeElement = (element, out, displayStyle, duration, onComplete) => {
    const startTime = performance.now();

    let startOpacity = element.style.display === 'none' ? 0 : parseFloat(element.style.opacity);
    if (isNaN(startOpacity)) startOpacity = 1;

    const interval = window.setInterval(() => {
        const currentTime = performance.now();
        const elapsed = currentTime - startTime;

        let t = Math.min(elapsed / duration, 1.0);
        if (t > 0.999) t = 1;

        let opacity;
        if (out) {
            opacity = (1.0 - t) * startOpacity;
            if (opacity < 0.0001) opacity = 0;
        } else {
            opacity = (1.0 - startOpacity) * t + startOpacity;
        }

        if (opacity > 0) {
            element.style.display = displayStyle;
            element.style.opacity = opacity;
        } else {
            element.style.display = 'none';
        }

        if (t >= 1) {
            if (onComplete) onComplete();
            window.clearInterval(interval);
        }
    }, 16);
    return interval;
};

const cancelFade = (interval) => {
    window.clearInterval(interval);
};

const STANDARD_FADE_DURATION = 500;

class LoadingSpinner {

    static elementIDGen = 0;

    constructor(message, container) {

        this.taskIDGen = 0;
        this.elementID = LoadingSpinner.elementIDGen++;

        this.tasks = [];

        this.message = message || 'Loading...';
        this.container = container || document.body;

        this.spinnerContainerOuter = document.createElement('div');
        this.spinnerContainerOuter.className = `spinnerOuterContainer${this.elementID}`;
        this.spinnerContainerOuter.style.display = 'none';

        this.spinnerContainerPrimary = document.createElement('div');
        this.spinnerContainerPrimary.className = `spinnerContainerPrimary${this.elementID}`;
        this.spinnerPrimary = document.createElement('div');
        this.spinnerPrimary.classList.add(`spinner${this.elementID}`, `spinnerPrimary${this.elementID}`);
        this.messageContainerPrimary = document.createElement('div');
        this.messageContainerPrimary.classList.add(`messageContainer${this.elementID}`, `messageContainerPrimary${this.elementID}`);
        this.messageContainerPrimary.innerHTML = this.message;

        this.spinnerContainerMin = document.createElement('div');
        this.spinnerContainerMin.className = `spinnerContainerMin${this.elementID}`;
        this.spinnerMin = document.createElement('div');
        this.spinnerMin.classList.add(`spinner${this.elementID}`, `spinnerMin${this.elementID}`);
        this.messageContainerMin = document.createElement('div');
        this.messageContainerMin.classList.add(`messageContainer${this.elementID}`, `messageContainerMin${this.elementID}`);
        this.messageContainerMin.innerHTML = this.message;

        this.spinnerContainerPrimary.appendChild(this.spinnerPrimary);
        this.spinnerContainerPrimary.appendChild(this.messageContainerPrimary);
        this.spinnerContainerOuter.appendChild(this.spinnerContainerPrimary);

        this.spinnerContainerMin.appendChild(this.spinnerMin);
        this.spinnerContainerMin.appendChild(this.messageContainerMin);
        this.spinnerContainerOuter.appendChild(this.spinnerContainerMin);

        const style = document.createElement('style');
        style.innerHTML = `

            .spinnerOuterContainer${this.elementID} {
                width: 100%;
                height: 100%;
                margin: 0;
                top: 0;
                left: 0;
                position: absolute;
                pointer-events: none;
            }

            .messageContainer${this.elementID} {
                height: 20px;
                font-family: arial;
                font-size: 12pt;
                color: #ffffff;
                text-align: center;
                vertical-align: middle;
            }

            .spinner${this.elementID} {
                padding: 15px;
                background: #07e8d6;
                z-index:99999;
            
                aspect-ratio: 1;
                border-radius: 50%;
                --_m: 
                    conic-gradient(#0000,#000),
                    linear-gradient(#000 0 0) content-box;
                -webkit-mask: var(--_m);
                    mask: var(--_m);
                -webkit-mask-composite: source-out;
                    mask-composite: subtract;
                box-sizing: border-box;
                animation: load 1s linear infinite;
            }

            .spinnerContainerPrimary${this.elementID} {
                z-index:99999;
                background-color: rgba(128, 128, 128, 0.75);
                border: #666666 1px solid;
                border-radius: 5px;
                padding-top: 20px;
                padding-bottom: 10px;
                margin: 0;
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-80px, -80px);
                width: 180px;
                pointer-events: auto;
            }

            .spinnerPrimary${this.elementID} {
                width: 120px;
                margin-left: 30px;
            }

            .messageContainerPrimary${this.elementID} {
                padding-top: 15px;
            }

            .spinnerContainerMin${this.elementID} {
                z-index:99999;
                background-color: rgba(128, 128, 128, 0.75);
                border: #666666 1px solid;
                border-radius: 5px;
                padding-top: 20px;
                padding-bottom: 15px;
                margin: 0;
                position: absolute;
                bottom: 50px;
                left: 50%;
                transform: translate(-50%, 0);
                display: flex;
                flex-direction: left;
                pointer-events: auto;
                min-width: 250px;
            }

            .messageContainerMin${this.elementID} {
                margin-right: 15px;
            }

            .spinnerMin${this.elementID} {
                width: 50px;
                height: 50px;
                margin-left: 15px;
                margin-right: 25px;
            }

            .messageContainerMin${this.elementID} {
                padding-top: 15px;
            }
            
            @keyframes load {
                to{transform: rotate(1turn)}
            }

        `;
        this.spinnerContainerOuter.appendChild(style);
        this.container.appendChild(this.spinnerContainerOuter);

        this.setMinimized(false, true);

        this.fadeTransitions = [];
    }

    addTask(message) {
        const newTask = {
            'message': message,
            'id': this.taskIDGen++
        };
        this.tasks.push(newTask);
        this.update();
        return newTask.id;
    }

    removeTask(id) {
        let index = 0;
        for (let task of this.tasks) {
            if (task.id === id) {
                this.tasks.splice(index, 1);
                break;
            }
            index++;
        }
        this.update();
    }

    removeAllTasks() {
        this.tasks = [];
        this.update();
    }

    setMessageForTask(id, message) {
        for (let task of this.tasks) {
            if (task.id === id) {
                task.message = message;
                break;
            }
        }
        this.update();
    }

    update() {
        if (this.tasks.length > 0) {
            this.show();
            this.setMessage(this.tasks[this.tasks.length - 1].message);
        } else {
            this.hide();
        }
    }

    show() {
        this.spinnerContainerOuter.style.display = 'block';
        this.visible = true;
    }

    hide() {
        this.spinnerContainerOuter.style.display = 'none';
        this.visible = false;
    }

    setContainer(container) {
        if (this.container) {
            this.container.removeChild(this.spinnerContainerOuter);
        }
        if (container) {
            this.container = container;
            this.container.appendChild(this.spinnerContainerOuter);
            this.spinnerContainerOuter.style.zIndex = this.container.style.zIndex + 1;
        }
    }

    setMinimized(minimized, instant) {
        const showHideSpinner = (element, show, instant, displayStyle, fadeTransitionsIndex) => {
            if (instant) {
                element.style.display = show ? displayStyle : 'none';
            } else {
                this.fadeTransitions[fadeTransitionsIndex] = fadeElement(element, !show, displayStyle, STANDARD_FADE_DURATION, () => {
                    this.fadeTransitions[fadeTransitionsIndex] = null;
                });
            }
        };
        showHideSpinner(this.spinnerContainerPrimary, !minimized, instant, 'block', 0);
        showHideSpinner(this.spinnerContainerMin, minimized, instant, 'flex', 1);
        this.minimized = minimized;
    }

    setMessage(msg) {
        this.messageContainerPrimary.innerHTML = msg;
        this.messageContainerMin.innerHTML = msg;
    }
}

class LoadingProgressBar {

    constructor(container) {

        this.idGen = 0;

        this.tasks = [];

        this.container = container || document.body;

        this.progressBarContainerOuter = document.createElement('div');
        this.progressBarContainerOuter.className = 'progressBarOuterContainer';
        this.progressBarContainerOuter.style.display = 'none';

        this.progressBarBox = document.createElement('div');
        this.progressBarBox.className = 'progressBarBox';

        this.progressBarBackground = document.createElement('div');
        this.progressBarBackground.className = 'progressBarBackground';

        this.progressBar = document.createElement('div');
        this.progressBar.className = 'progressBar';

        this.progressBarBackground.appendChild(this.progressBar);
        this.progressBarBox.appendChild(this.progressBarBackground);
        this.progressBarContainerOuter.appendChild(this.progressBarBox);

        const style = document.createElement('style');
        style.innerHTML = `

            .progressBarOuterContainer {
                width: 100%;
                height: 100%;
                margin: 0;
                top: 0;
                left: 0;
                position: absolute;
                pointer-events: none;
            }

            .progressBarBox {
                z-index:99999;
                padding: 7px 9px 5px 7px;
                background-color: rgba(190, 190, 190, 0.75);
                border: #555555 1px solid;
                border-radius: 15px;
                margin: 0;
                position: absolute;
                bottom: 50px;
                left: 50%;
                transform: translate(-50%, 0);
                width: 180px;
                height: 30px;
                pointer-events: auto;
            }

            .progressBarBackground {
                width: 100%;
                height: 25px;
                border-radius:10px;
                background-color: rgba(128, 128, 128, 0.75);
                border: #444444 1px solid;
                box-shadow: inset 0 0 10px #333333;
            }

            .progressBar {
                height: 25px;
                width: 0px;
                border-radius:10px;
                background-color: rgba(0, 200, 0, 0.75);
                box-shadow: inset 0 0 10px #003300;
            }

        `;
        this.progressBarContainerOuter.appendChild(style);
        this.container.appendChild(this.progressBarContainerOuter);
    }

    show() {
        this.progressBarContainerOuter.style.display = 'block';
    }

    hide() {
        this.progressBarContainerOuter.style.display = 'none';
    }

    setProgress(progress) {
        this.progressBar.style.width = progress + '%';
    }

    setContainer(container) {
        if (this.container) {
            this.container.removeChild(this.progressBarContainerOuter);
        }
        if (container) {
            this.container = container;
            this.container.appendChild(this.progressBarContainerOuter);
            this.progressBarContainerOuter.style.zIndex = this.container.style.zIndex + 1;
        }
    }

}

class InfoPanel {

    constructor(container) {

        this.container = container || document.body;

        this.infoCells = {};

        const layout = [
            ['Camera position', 'cameraPosition'],
            ['Camera look-at', 'cameraLookAt'],
            ['Camera up', 'cameraUp'],
            ['Camera mode', 'orthographicCamera'],
            ['Cursor position', 'cursorPosition'],
            ['FPS', 'fps'],
            ['Rendering:', 'renderSplatCount'],
            ['Sort time', 'sortTime'],
            ['Render window', 'renderWindow'],
            ['Focal adjustment', 'focalAdjustment'],
            ['Splat scale', 'splatScale'],
            ['Point cloud mode', 'pointCloudMode']
        ];

        this.infoPanelContainer = document.createElement('div');
        const style = document.createElement('style');
        style.innerHTML = `

            .infoPanel {
                width: 430px;
                padding: 10px;
                background-color: rgba(50, 50, 50, 0.85);
                border: #555555 2px solid;
                color: #dddddd;
                border-radius: 10px;
                z-index: 9999;
                font-family: arial;
                font-size: 11pt;
                text-align: left;
                margin: 0;
                top: 10px;
                left:10px;
                position: absolute;
                pointer-events: auto;
            }

            .info-panel-cell {
                margin-bottom: 5px;
                padding-bottom: 2px;
            }

            .label-cell {
                font-weight: bold;
                font-size: 12pt;
                width: 140px;
            }

        `;
        this.infoPanelContainer.append(style);

        this.infoPanel = document.createElement('div');
        this.infoPanel.className = 'infoPanel';

        const infoTable = document.createElement('div');
        infoTable.style.display = 'table';

        for (let layoutEntry of layout) {
            const row = document.createElement('div');
            row.style.display = 'table-row';
            row.className = 'info-panel-row';

            const labelCell = document.createElement('div');
            labelCell.style.display = 'table-cell';
            labelCell.innerHTML = `${layoutEntry[0]}: `;
            labelCell.classList.add('info-panel-cell', 'label-cell');

            const spacerCell = document.createElement('div');
            spacerCell.style.display = 'table-cell';
            spacerCell.style.width = '10px';
            spacerCell.innerHTML = ' ';
            spacerCell.className = 'info-panel-cell';

            const infoCell = document.createElement('div');
            infoCell.style.display = 'table-cell';
            infoCell.innerHTML = '';
            infoCell.className = 'info-panel-cell';

            this.infoCells[layoutEntry[1]] = infoCell;

            row.appendChild(labelCell);
            row.appendChild(spacerCell);
            row.appendChild(infoCell);

            infoTable.appendChild(row);
        }

        this.infoPanel.appendChild(infoTable);
        this.infoPanelContainer.append(this.infoPanel);
        this.infoPanelContainer.style.display = 'none';
        this.container.appendChild(this.infoPanelContainer);

        this.visible = false;
    }

    update = function(renderDimensions, cameraPosition, cameraLookAtPosition, cameraUp, orthographicCamera,
                      meshCursorPosition, currentFPS, splatCount, splatRenderCount,
                      splatRenderCountPct, lastSortTime, focalAdjustment, splatScale, pointCloudMode) {

        const cameraPosString = `${cameraPosition.x.toFixed(5)}, ${cameraPosition.y.toFixed(5)}, ${cameraPosition.z.toFixed(5)}`;
        if (this.infoCells.cameraPosition.innerHTML !== cameraPosString) {
            this.infoCells.cameraPosition.innerHTML = cameraPosString;
        }

        if (cameraLookAtPosition) {
            const cla = cameraLookAtPosition;
            const cameraLookAtString = `${cla.x.toFixed(5)}, ${cla.y.toFixed(5)}, ${cla.z.toFixed(5)}`;
            if (this.infoCells.cameraLookAt.innerHTML !== cameraLookAtString) {
                this.infoCells.cameraLookAt.innerHTML = cameraLookAtString;
            }
        }

        const cameraUpString = `${cameraUp.x.toFixed(5)}, ${cameraUp.y.toFixed(5)}, ${cameraUp.z.toFixed(5)}`;
        if (this.infoCells.cameraUp.innerHTML !== cameraUpString) {
            this.infoCells.cameraUp.innerHTML = cameraUpString;
        }

        this.infoCells.orthographicCamera.innerHTML = orthographicCamera ? 'Orthographic' : 'Perspective';

        if (meshCursorPosition) {
            const cursPos = meshCursorPosition;
            const cursorPosString = `${cursPos.x.toFixed(5)}, ${cursPos.y.toFixed(5)}, ${cursPos.z.toFixed(5)}`;
            this.infoCells.cursorPosition.innerHTML = cursorPosString;
        } else {
            this.infoCells.cursorPosition.innerHTML = 'N/A';
        }

        this.infoCells.fps.innerHTML = currentFPS;
        this.infoCells.renderWindow.innerHTML = `${renderDimensions.x} x ${renderDimensions.y}`;

        this.infoCells.renderSplatCount.innerHTML =
            `${splatRenderCount} splats out of ${splatCount} (${splatRenderCountPct.toFixed(2)}%)`;

        this.infoCells.sortTime.innerHTML = `${lastSortTime.toFixed(3)} ms`;
        this.infoCells.focalAdjustment.innerHTML = `${focalAdjustment.toFixed(3)}`;
        this.infoCells.splatScale.innerHTML = `${splatScale.toFixed(3)}`;
        this.infoCells.pointCloudMode.innerHTML = `${pointCloudMode}`;
    };

    setContainer(container) {
        if (this.container) {
            this.container.removeChild(this.infoPanelContainer);
        }
        if (container) {
            this.container = container;
            this.container.appendChild(this.infoPanelContainer);
            this.infoPanelContainer.style.zIndex = this.container.style.zIndex + 1;
        }
    }

    show() {
        this.infoPanelContainer.style.display = 'block';
        this.visible = true;
    }

    hide() {
        this.infoPanelContainer.style.display = 'none';
        this.visible = false;
    }

}

class ArrowHelper extends THREE.Object3D {

    constructor(dir = new THREE.Vector3(0, 0, 1), origin = new THREE.Vector3(0, 0, 0), length = 1,
                radius = 0.1, color = 0xffff00, headLength = length * 0.2, headRadius = headLength * 0.2) {
        super();

        this.type = 'ArrowHelper';

        const lineGeometry = new THREE.CylinderGeometry(radius, radius, length, 32);
        lineGeometry.translate(0, length / 2.0, 0);
        const coneGeometry = new THREE.CylinderGeometry( 0, headRadius, headLength, 32);
        coneGeometry.translate(0, length, 0);

        this.position.copy( origin );

        this.line = new THREE.Mesh(lineGeometry, new THREE.MeshBasicMaterial({color: color, toneMapped: false}));
        this.line.matrixAutoUpdate = false;
        this.add(this.line);

        this.cone = new THREE.Mesh(coneGeometry, new THREE.MeshBasicMaterial({color: color, toneMapped: false}));
        this.cone.matrixAutoUpdate = false;
        this.add(this.cone);

        this.setDirection(dir);
    }

    setDirection( dir ) {
        if (dir.y > 0.99999) {
            this.quaternion.set(0, 0, 0, 1);
        } else if (dir.y < - 0.99999) {
            this.quaternion.set(1, 0, 0, 0);
        } else {
            _axis.set(dir.z, 0, -dir.x).normalize();
            const radians = Math.acos(dir.y);
            this.quaternion.setFromAxisAngle(_axis, radians);
        }
    }

    setColor( color ) {
        this.line.material.color.set(color);
        this.cone.material.color.set(color);
    }

    copy(source) {
        super.copy(source, false);
        this.line.copy(source.line);
        this.cone.copy(source.cone);
        return this;
    }

    dispose() {
        this.line.geometry.dispose();
        this.line.material.dispose();
        this.cone.geometry.dispose();
        this.cone.material.dispose();
    }

}

class SceneHelper {

    constructor(threeScene) {
        this.threeScene = threeScene;
        this.splatRenderTarget = null;
        this.renderTargetCopyQuad = null;
        this.renderTargetCopyCamera = null;
        this.meshCursor = null;
        this.focusMarker = null;
        this.controlPlane = null;
        this.debugRoot = null;
        this.secondaryDebugRoot = null;
    }

    updateSplatRenderTargetForRenderDimensions(width, height) {
        this.destroySplatRendertarget();
        this.splatRenderTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            stencilBuffer: false,
            depthBuffer: true,

        });
        this.splatRenderTarget.depthTexture = new THREE.DepthTexture(width, height);
        this.splatRenderTarget.depthTexture.format = THREE.DepthFormat;
        this.splatRenderTarget.depthTexture.type = THREE.UnsignedIntType;
    }

    destroySplatRendertarget() {
        if (this.splatRenderTarget) {
            this.splatRenderTarget = null;
        }
    }

    setupRenderTargetCopyObjects() {
        const uniforms = {
            'sourceColorTexture': {
                'type': 't',
                'value': null
            },
            'sourceDepthTexture': {
                'type': 't',
                'value': null
            },
        };
        const renderTargetCopyMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4( position.xy, 0.0, 1.0 );    
                }
            `,
            fragmentShader: `
                #include <common>
                #include <packing>
                varying vec2 vUv;
                uniform sampler2D sourceColorTexture;
                uniform sampler2D sourceDepthTexture;
                void main() {
                    vec4 color = texture2D(sourceColorTexture, vUv);
                    float fragDepth = texture2D(sourceDepthTexture, vUv).x;
                    gl_FragDepth = fragDepth;
                    gl_FragColor = vec4(color.rgb, color.a * 2.0);
              }
            `,
            uniforms: uniforms,
            depthWrite: false,
            depthTest: false,
            transparent: true,
            blending: THREE.CustomBlending,
            blendSrc: THREE.SrcAlphaFactor,
            blendSrcAlpha: THREE.SrcAlphaFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor
        });
        renderTargetCopyMaterial.extensions.fragDepth = true;
        this.renderTargetCopyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), renderTargetCopyMaterial);
        this.renderTargetCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    destroyRenderTargetCopyObjects() {
        if (this.renderTargetCopyQuad) {
            disposeAllMeshes(this.renderTargetCopyQuad);
            this.renderTargetCopyQuad = null;
        }
    }

    setupMeshCursor() {
        if (!this.meshCursor) {
            const coneGeometry = new THREE.ConeGeometry(0.5, 1.5, 32);
            const coneMaterial = new THREE.MeshBasicMaterial({color: 0xFFFFFF});

            const downArrow = new THREE.Mesh(coneGeometry, coneMaterial);
            downArrow.rotation.set(0, 0, Math.PI);
            downArrow.position.set(0, 1, 0);
            const upArrow = new THREE.Mesh(coneGeometry, coneMaterial);
            upArrow.position.set(0, -1, 0);
            const leftArrow = new THREE.Mesh(coneGeometry, coneMaterial);
            leftArrow.rotation.set(0, 0, Math.PI / 2.0);
            leftArrow.position.set(1, 0, 0);
            const rightArrow = new THREE.Mesh(coneGeometry, coneMaterial);
            rightArrow.rotation.set(0, 0, -Math.PI / 2.0);
            rightArrow.position.set(-1, 0, 0);

            this.meshCursor = new THREE.Object3D();
            this.meshCursor.add(downArrow);
            this.meshCursor.add(upArrow);
            this.meshCursor.add(leftArrow);
            this.meshCursor.add(rightArrow);
            this.meshCursor.scale.set(0.1, 0.1, 0.1);
            this.threeScene.add(this.meshCursor);
            this.meshCursor.visible = false;
        }
    }

    destroyMeshCursor() {
        if (this.meshCursor) {
            disposeAllMeshes(this.meshCursor);
            this.threeScene.remove(this.meshCursor);
            this.meshCursor = null;
        }
    }

    setMeshCursorVisibility(visible) {
        this.meshCursor.visible = visible;
    }

    getMeschCursorVisibility() {
        return this.meshCursor.visible;
    }

    setMeshCursorPosition(position) {
        this.meshCursor.position.copy(position);
    }

    positionAndOrientMeshCursor(position, camera) {
        this.meshCursor.position.copy(position);
        this.meshCursor.up.copy(camera.up);
        this.meshCursor.lookAt(camera.position);
    }

    setupFocusMarker() {
        if (!this.focusMarker) {
            const sphereGeometry = new THREE.SphereGeometry(.5, 32, 32);
            const focusMarkerMaterial = SceneHelper.buildFocusMarkerMaterial();
            focusMarkerMaterial.depthTest = false;
            focusMarkerMaterial.depthWrite = false;
            focusMarkerMaterial.transparent = true;
            this.focusMarker = new THREE.Mesh(sphereGeometry, focusMarkerMaterial);
        }
    }

    destroyFocusMarker() {
        if (this.focusMarker) {
            disposeAllMeshes(this.focusMarker);
            this.focusMarker = null;
        }
    }

    updateFocusMarker = function() {

        const tempPosition = new THREE.Vector3();
        const tempMatrix = new THREE.Matrix4();
        const toCamera = new THREE.Vector3();

        return function(position, camera, viewport) {
            tempMatrix.copy(camera.matrixWorld).invert();
            tempPosition.copy(position).applyMatrix4(tempMatrix);
            tempPosition.normalize().multiplyScalar(10);
            tempPosition.applyMatrix4(camera.matrixWorld);
            toCamera.copy(camera.position).sub(position);
            const toCameraDistance = toCamera.length();
            this.focusMarker.position.copy(position);
            this.focusMarker.scale.set(toCameraDistance, toCameraDistance, toCameraDistance);
            this.focusMarker.material.uniforms.realFocusPosition.value.copy(position);
            this.focusMarker.material.uniforms.viewport.value.copy(viewport);
            this.focusMarker.material.uniformsNeedUpdate = true;
        };

    }();

    setFocusMarkerVisibility(visible) {
        this.focusMarker.visible = visible;
    }

    setFocusMarkerOpacity(opacity) {
        this.focusMarker.material.uniforms.opacity.value = opacity;
        this.focusMarker.material.uniformsNeedUpdate = true;
    }

    getFocusMarkerOpacity() {
        return this.focusMarker.material.uniforms.opacity.value;
    }

    setupControlPlane() {
        if (!this.controlPlane) {
            const planeGeometry = new THREE.PlaneGeometry(1, 1);
            planeGeometry.rotateX(-Math.PI / 2);
            const planeMaterial = new THREE.MeshBasicMaterial({color: 0xffffff});
            planeMaterial.transparent = true;
            planeMaterial.opacity = 0.6;
            planeMaterial.depthTest = false;
            planeMaterial.depthWrite = false;
            planeMaterial.side = THREE.DoubleSide;
            const planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);

            const arrowDir = new THREE.Vector3(0, 1, 0);
            arrowDir.normalize();
            const arrowOrigin = new THREE.Vector3(0, 0, 0);
            const arrowLength = 0.5;
            const arrowRadius = 0.01;
            const arrowColor = 0x00dd00;
            const arrowHelper = new ArrowHelper(arrowDir, arrowOrigin, arrowLength, arrowRadius, arrowColor, 0.1, 0.03);

            this.controlPlane = new THREE.Object3D();
            this.controlPlane.add(planeMesh);
            this.controlPlane.add(arrowHelper);
        }
    }

    destroyControlPlane() {
        if (this.controlPlane) {
            disposeAllMeshes(this.controlPlane);
            this.controlPlane = null;
        }
    }

    setControlPlaneVisibility(visible) {
        this.controlPlane.visible = visible;
    }

    positionAndOrientControlPlane = function() {

        const tempQuaternion = new THREE.Quaternion();
        const defaultUp = new THREE.Vector3(0, 1, 0);

        return function(position, up) {
            tempQuaternion.setFromUnitVectors(defaultUp, up);
            this.controlPlane.position.copy(position);
            this.controlPlane.quaternion.copy(tempQuaternion);
        };

    }();

    addDebugMeshes() {
        this.debugRoot = this.createDebugMeshes();
        this.secondaryDebugRoot = this.createSecondaryDebugMeshes();
        this.threeScene.add(this.debugRoot);
        this.threeScene.add(this.secondaryDebugRoot);
    }

    destroyDebugMeshes() {
        for (let debugRoot of [this.debugRoot, this.secondaryDebugRoot]) {
            if (debugRoot) {
                disposeAllMeshes(debugRoot);
                this.threeScene.remove(debugRoot);
            }
        }
        this.debugRoot = null;
        this.secondaryDebugRoot = null;
    }

    createDebugMeshes(renderOrder) {
        const sphereGeometry = new THREE.SphereGeometry(1, 32, 32);
        const debugMeshRoot = new THREE.Object3D();

        const createMesh = (color, position) => {
            let sphereMesh = new THREE.Mesh(sphereGeometry, SceneHelper.buildDebugMaterial(color));
            sphereMesh.renderOrder = renderOrder;
            debugMeshRoot.add(sphereMesh);
            sphereMesh.position.fromArray(position);
        };

        createMesh(0xff0000, [-50, 0, 0]);
        createMesh(0xff0000, [50, 0, 0]);
        createMesh(0x00ff00, [0, 0, -50]);
        createMesh(0x00ff00, [0, 0, 50]);
        createMesh(0xffaa00, [5, 0, 5]);

        return debugMeshRoot;
    }

    createSecondaryDebugMeshes(renderOrder) {
        const boxGeometry = new THREE.BoxGeometry(3, 3, 3);
        const debugMeshRoot = new THREE.Object3D();

        let boxColor = 0xBBBBBB;
        const createMesh = (position) => {
            let boxMesh = new THREE.Mesh(boxGeometry, SceneHelper.buildDebugMaterial(boxColor));
            boxMesh.renderOrder = renderOrder;
            debugMeshRoot.add(boxMesh);
            boxMesh.position.fromArray(position);
        };

        let separation = 10;
        createMesh([-separation, 0, -separation]);
        createMesh([-separation, 0, separation]);
        createMesh([separation, 0, -separation]);
        createMesh([separation, 0, separation]);

        return debugMeshRoot;
    }

    static buildDebugMaterial(color) {
        const vertexShaderSource = `
            #include <common>
            varying float ndcDepth;

            void main() {
                gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position.xyz, 1.0);
                ndcDepth = gl_Position.z / gl_Position.w;
                gl_Position.x = gl_Position.x / gl_Position.w;
                gl_Position.y = gl_Position.y / gl_Position.w;
                gl_Position.z = 0.0;
                gl_Position.w = 1.0;
    
            }
        `;

        const fragmentShaderSource = `
            #include <common>
            uniform vec3 color;
            varying float ndcDepth;
            void main() {
                gl_FragDepth = (ndcDepth + 1.0) / 2.0;
                gl_FragColor = vec4(color.rgb, 0.0);
            }
        `;

        const uniforms = {
            'color': {
                'type': 'v3',
                'value': new THREE.Color(color)
            },
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: false,
            depthTest: true,
            depthWrite: true,
            side: THREE.FrontSide
        });
        material.extensions.fragDepth = true;

        return material;
    }

    static buildFocusMarkerMaterial(color) {
        const vertexShaderSource = `
            #include <common>

            uniform vec2 viewport;
            uniform vec3 realFocusPosition;

            varying vec4 ndcPosition;
            varying vec4 ndcCenter;
            varying vec4 ndcFocusPosition;

            void main() {
                float radius = 0.01;

                vec4 viewPosition = modelViewMatrix * vec4(position.xyz, 1.0);
                vec4 viewCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);

                vec4 viewFocusPosition = modelViewMatrix * vec4(realFocusPosition, 1.0);

                ndcPosition = projectionMatrix * viewPosition;
                ndcPosition = ndcPosition * vec4(1.0 / ndcPosition.w);
                ndcCenter = projectionMatrix * viewCenter;
                ndcCenter = ndcCenter * vec4(1.0 / ndcCenter.w);

                ndcFocusPosition = projectionMatrix * viewFocusPosition;
                ndcFocusPosition = ndcFocusPosition * vec4(1.0 / ndcFocusPosition.w);

                gl_Position = projectionMatrix * viewPosition;

            }
        `;

        const fragmentShaderSource = `
            #include <common>
            uniform vec3 color;
            uniform vec2 viewport;
            uniform float opacity;

            varying vec4 ndcPosition;
            varying vec4 ndcCenter;
            varying vec4 ndcFocusPosition;

            void main() {
                vec2 screenPosition = vec2(ndcPosition) * viewport;
                vec2 screenCenter = vec2(ndcCenter) * viewport;

                vec2 screenVec = screenPosition - screenCenter;

                float projectedRadius = length(screenVec);

                float lineWidth = 0.0005 * viewport.y;
                float aaRange = 0.0025 * viewport.y;
                float radius = 0.06 * viewport.y;
                float radDiff = abs(projectedRadius - radius) - lineWidth;
                float alpha = 1.0 - clamp(radDiff / 5.0, 0.0, 1.0); 

                gl_FragColor = vec4(color.rgb, alpha * opacity);
            }
        `;

        const uniforms = {
            'color': {
                'type': 'v3',
                'value': new THREE.Color(color)
            },
            'realFocusPosition': {
                'type': 'v3',
                'value': new THREE.Vector3()
            },
            'viewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'opacity': {
                'value': 0.0
            }
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.FrontSide
        });

        return material;
    }

    dispose() {
        this.destroyMeshCursor();
        this.destroyFocusMarker();
        this.destroyDebugMeshes();
        this.destroyControlPlane();
        this.destroyRenderTargetCopyObjects();
        this.destroySplatRendertarget();
    }
}

const VectorRight = new THREE.Vector3(1, 0, 0);
const VectorUp = new THREE.Vector3(0, 1, 0);
const VectorBackward = new THREE.Vector3(0, 0, 1);

class Ray {

    constructor(origin = new THREE.Vector3(), direction = new THREE.Vector3()) {
        this.origin = new THREE.Vector3();
        this.direction = new THREE.Vector3();
        this.setParameters(origin, direction);
    }

    setParameters(origin, direction) {
        this.origin.copy(origin);
        this.direction.copy(direction).normalize();
    }

    boxContainsPoint(box, point, epsilon) {
        return point.x < box.min.x - epsilon || point.x > box.max.x + epsilon ||
               point.y < box.min.y - epsilon || point.y > box.max.y + epsilon ||
               point.z < box.min.z - epsilon || point.z > box.max.z + epsilon ? false : true;
    }

    intersectBox = function() {

        const planeIntersectionPoint = new THREE.Vector3();
        const planeIntersectionPointArray = [];
        const originArray = [];
        const directionArray = [];

        return function(box, outHit) {

            originArray[0] = this.origin.x;
            originArray[1] = this.origin.y;
            originArray[2] = this.origin.z;
            directionArray[0] = this.direction.x;
            directionArray[1] = this.direction.y;
            directionArray[2] = this.direction.z;

            if (this.boxContainsPoint(box, this.origin, 0.0001)) {
                if (outHit) {
                    outHit.origin.copy(this.origin);
                    outHit.normal.set(0, 0, 0);
                    outHit.distance = -1;
                }
                return true;
            }

            for (let i = 0; i < 3; i++) {
                if (directionArray[i] == 0.0) continue;

                const hitNormal = i == 0 ? VectorRight : i == 1 ? VectorUp : VectorBackward;
                const extremeVec = directionArray[i] < 0 ? box.max : box.min;
                let multiplier = -Math.sign(directionArray[i]);
                planeIntersectionPointArray[0] = i == 0 ? extremeVec.x : i == 1 ? extremeVec.y : extremeVec.z;
                let toSide = planeIntersectionPointArray[0] - originArray[i];

                if (toSide * multiplier < 0) {
                    const idx1 = (i + 1) % 3;
                    const idx2 = (i + 2) % 3;
                    planeIntersectionPointArray[2] = directionArray[idx1] / directionArray[i] * toSide + originArray[idx1];
                    planeIntersectionPointArray[1] = directionArray[idx2] / directionArray[i] * toSide + originArray[idx2];
                    planeIntersectionPoint.set(planeIntersectionPointArray[i],
                                               planeIntersectionPointArray[idx2],
                                               planeIntersectionPointArray[idx1]);
                    if (this.boxContainsPoint(box, planeIntersectionPoint, 0.0001)) {
                        if (outHit) {
                            outHit.origin.copy(planeIntersectionPoint);
                            outHit.normal.copy(hitNormal).multiplyScalar(multiplier);
                            outHit.distance = planeIntersectionPoint.sub(this.origin).length();
                        }
                        return true;
                    }
                }
            }

            return false;
        };

    }();

    intersectSphere = function() {

        const toSphereCenterVec = new THREE.Vector3();

        return function(center, radius, outHit) {
            toSphereCenterVec.copy(center).sub(this.origin);
            const toClosestApproach = toSphereCenterVec.dot(this.direction);
            const toClosestApproachSq = toClosestApproach * toClosestApproach;
            const toSphereCenterSq = toSphereCenterVec.dot(toSphereCenterVec);
            const diffSq = toSphereCenterSq - toClosestApproachSq;
            const radiusSq = radius * radius;

            if (diffSq > radiusSq) return false;

            const thc = Math.sqrt(radiusSq - diffSq);
            const t0 = toClosestApproach - thc;
            const t1 = toClosestApproach + thc;

            if (t1 < 0) return false;
            let t = t0 < 0 ? t1 : t0;

            if (outHit) {
                outHit.origin.copy(this.origin).addScaledVector(this.direction, t);
                outHit.normal.copy(outHit.origin).sub(center).normalize();
                outHit.distance = t;
            }
            return true;
        };

    }();
}

class Hit {

    constructor() {
        this.origin = new THREE.Vector3();
        this.normal = new THREE.Vector3();
        this.distance = 0;
        this.splatIndex = 0;
    }

    set(origin, normal, distance, splatIndex) {
        this.origin.copy(origin);
        this.normal.copy(normal);
        this.distance = distance;
        this.splatIndex = splatIndex;
    }

    clone() {
        const hitClone = new Hit();
        hitClone.origin.copy(this.origin);
        hitClone.normal.copy(this.normal);
        hitClone.distance = this.distance;
        hitClone.splatIndex = this.splatIndex;
        return hitClone;
    }

}

class Raycaster {

    constructor(origin, direction, raycastAgainstTrueSplatEllipsoid = false) {
        this.ray = new Ray(origin, direction);
        this.raycastAgainstTrueSplatEllipsoid = raycastAgainstTrueSplatEllipsoid;
    }

    setFromCameraAndScreenPosition = function() {

        const ndcCoords = new THREE.Vector2();

        return function(camera, screenPosition, screenDimensions) {
            ndcCoords.x = screenPosition.x / screenDimensions.x * 2.0 - 1.0;
            ndcCoords.y = (screenDimensions.y - screenPosition.y) / screenDimensions.y * 2.0 - 1.0;
            if (camera.isPerspectiveCamera) {
                this.ray.origin.setFromMatrixPosition(camera.matrixWorld);
                this.ray.direction.set(ndcCoords.x, ndcCoords.y, 0.5 ).unproject(camera).sub(this.ray.origin).normalize();
                this.camera = camera;
            } else if (camera.isOrthographicCamera) {
                this.ray.origin.set(ndcCoords.x, ndcCoords.y,
                                   (camera.near + camera.far) / (camera.near - camera.far)).unproject(camera);
                this.ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
                this.camera = camera;
            } else {
                throw new Error('Raycaster::setFromCameraAndScreenPosition() -> Unsupported camera type');
            }
        };

    }();

    intersectSplatMesh = function() {

        const toLocal = new THREE.Matrix4();
        const fromLocal = new THREE.Matrix4();
        const sceneTransform = new THREE.Matrix4();
        const localRay = new Ray();
        const tempPoint = new THREE.Vector3();

        return function(splatMesh, outHits = []) {
            const splatTree = splatMesh.getSplatTree();

            if (!splatTree) return;

            for (let s = 0; s < splatTree.subTrees.length; s++) {
                const subTree = splatTree.subTrees[s];

                fromLocal.copy(splatMesh.matrixWorld);
                if (splatMesh.dynamicMode) {
                    splatMesh.getSceneTransform(s, sceneTransform);
                    fromLocal.multiply(sceneTransform);
                }
                toLocal.copy(fromLocal).invert();

                localRay.origin.copy(this.ray.origin).applyMatrix4(toLocal);
                localRay.direction.copy(this.ray.origin).add(this.ray.direction);
                localRay.direction.applyMatrix4(toLocal).sub(localRay.origin).normalize();

                const outHitsForSubTree = [];
                if (subTree.rootNode) {
                    this.castRayAtSplatTreeNode(localRay, splatTree, subTree.rootNode, outHitsForSubTree);
                }

                outHitsForSubTree.forEach((hit) => {
                    hit.origin.applyMatrix4(fromLocal);
                    hit.normal.applyMatrix4(fromLocal).normalize();
                    hit.distance = tempPoint.copy(hit.origin).sub(this.ray.origin).length();
                });

                outHits.push(...outHitsForSubTree);
            }

            outHits.sort((a, b) => {
                if (a.distance > b.distance) return 1;
                else return -1;
            });

            return outHits;
        };

    }();

    castRayAtSplatTreeNode = function() {

        const tempColor = new THREE.Vector4();
        const tempCenter = new THREE.Vector3();
        const tempScale = new THREE.Vector3();
        const tempRotation = new THREE.Quaternion();
        const tempHit = new Hit();
        const scaleEpsilon = 0.0000001;

        const origin = new THREE.Vector3(0, 0, 0);
        const uniformScaleMatrix = new THREE.Matrix4();
        const scaleMatrix = new THREE.Matrix4();
        const rotationMatrix = new THREE.Matrix4();
        const toSphereSpace = new THREE.Matrix4();
        const fromSphereSpace = new THREE.Matrix4();
        const tempRay = new Ray();

        return function(ray, splatTree, node, outHits = []) {
            if (!ray.intersectBox(node.boundingBox)) {
                return;
            }
            if (node.data && node.data.indexes && node.data.indexes.length > 0) {
                for (let i = 0; i < node.data.indexes.length; i++) {
                    const splatGlobalIndex = node.data.indexes[i];
                    splatTree.splatMesh.getSplatColor(splatGlobalIndex, tempColor);
                    splatTree.splatMesh.getSplatCenter(splatGlobalIndex, tempCenter);
                    splatTree.splatMesh.getSplatScaleAndRotation(splatGlobalIndex, tempScale, tempRotation);

                    if (tempScale.x <= scaleEpsilon || tempScale.y <= scaleEpsilon || tempScale.z <= scaleEpsilon) {
                        continue;
                    }

                    if (!this.raycastAgainstTrueSplatEllipsoid) {
                        const radius = (tempScale.x + tempScale.y + tempScale.z) / 3;
                        if (ray.intersectSphere(tempCenter, radius, tempHit)) {
                            const hitClone = tempHit.clone();
                            hitClone.splatIndex = splatGlobalIndex;
                            outHits.push(hitClone);
                        }
                    } else {
                        scaleMatrix.makeScale(tempScale.x, tempScale.y, tempScale.z);
                        rotationMatrix.makeRotationFromQuaternion(tempRotation);
                        const uniformScale = Math.log10(tempColor.w) * 2.0;
                        uniformScaleMatrix.makeScale(uniformScale, uniformScale, uniformScale);
                        fromSphereSpace.copy(uniformScaleMatrix).multiply(rotationMatrix).multiply(scaleMatrix);
                        toSphereSpace.copy(fromSphereSpace).invert();
                        tempRay.origin.copy(ray.origin).sub(tempCenter).applyMatrix4(toSphereSpace);
                        tempRay.direction.copy(ray.origin).add(ray.direction).sub(tempCenter);
                        tempRay.direction.applyMatrix4(toSphereSpace).sub(tempRay.origin).normalize();
                        if (tempRay.intersectSphere(origin, 1.0, tempHit)) {
                            const hitClone = tempHit.clone();
                            hitClone.splatIndex = splatGlobalIndex;
                            hitClone.origin.applyMatrix4(fromSphereSpace).add(tempCenter);
                            outHits.push(hitClone);
                        }
                    }
                }
             }
            if (node.children && node.children.length > 0) {
                for (let child of node.children) {
                    this.castRayAtSplatTreeNode(ray, splatTree, child, outHits);
                }
            }
            return outHits;
        };

    }();
}

/**
 * SplatScene: Descriptor for a single splat scene managed by an instance of SplatMesh.
 */
class SplatScene {

    constructor(splatBuffer, position = new THREE.Vector3(), quaternion = new THREE.Quaternion(),
                scale = new THREE.Vector3(1, 1, 1), minimumAlpha = 1) {
        this.splatBuffer = splatBuffer;
        this.position = position.clone();
        this.quaternion = quaternion.clone();
        this.scale = scale.clone();
        this.transform = new THREE.Matrix4();
        this.minimumAlpha = minimumAlpha;
        this.updateTransform();
    }

    copyTransformData(otherScene) {
        this.position.copy(otherScene.position);
        this.quaternion.copy(otherScene.quaternion);
        this.scale.copy(otherScene.scale);
        this.transform.copy(otherScene.transform);
    }

    updateTransform() {
        this.transform.compose(this.position, this.quaternion, this.scale);
    }
}

class SplatTreeNode {

    static idGen = 0;

    constructor(min, max, depth, id) {
        this.min = new THREE.Vector3().copy(min);
        this.max = new THREE.Vector3().copy(max);
        this.boundingBox = new THREE.Box3(this.min, this.max);
        this.center = new THREE.Vector3().copy(this.max).sub(this.min).multiplyScalar(0.5).add(this.min);
        this.depth = depth;
        this.children = [];
        this.data = null;
        this.id = id || SplatTreeNode.idGen++;
    }

}

class SplatSubTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.sceneDimensions = new THREE.Vector3();
        this.sceneMin = new THREE.Vector3();
        this.sceneMax = new THREE.Vector3();
        this.rootNode = null;
        this.nodesWithIndexes = [];
        this.splatMesh = null;
    }

    static convertWorkerSubTreeNode(workerSubTreeNode) {
        const minVector = new THREE.Vector3().fromArray(workerSubTreeNode.min);
        const maxVector = new THREE.Vector3().fromArray(workerSubTreeNode.max);
        const convertedNode = new SplatTreeNode(minVector, maxVector, workerSubTreeNode.depth, workerSubTreeNode.id);
        if (workerSubTreeNode.data.indexes) {
            convertedNode.data = {
                'indexes': []
            };
            for (let index of workerSubTreeNode.data.indexes) {
                convertedNode.data.indexes.push(index);
            }
        }
        if (workerSubTreeNode.children) {
            for (let child of workerSubTreeNode.children) {
                convertedNode.children.push(SplatSubTree.convertWorkerSubTreeNode(child));
            }
        }
        return convertedNode;
    }

    static convertWorkerSubTree(workerSubTree, splatMesh) {
        const convertedSubTree = new SplatSubTree(workerSubTree.maxDepth, workerSubTree.maxCentersPerNode);
        convertedSubTree.sceneMin = new THREE.Vector3().fromArray(workerSubTree.sceneMin);
        convertedSubTree.sceneMax = new THREE.Vector3().fromArray(workerSubTree.sceneMax);

        convertedSubTree.splatMesh = splatMesh;
        convertedSubTree.rootNode = SplatSubTree.convertWorkerSubTreeNode(workerSubTree.rootNode);


        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        convertedSubTree.nodesWithIndexes = [];
        visitLeavesFromNode(convertedSubTree.rootNode, (node) => {
            if (node.data && node.data.indexes && node.data.indexes.length > 0) {
                convertedSubTree.nodesWithIndexes.push(node);
            }
        });

        return convertedSubTree;
    }
}

function createSplatTreeWorker(self) {

    let WorkerSplatTreeNodeIDGen = 0;

    class WorkerBox3 {

        constructor(min, max) {
            this.min = [min[0], min[1], min[2]];
            this.max = [max[0], max[1], max[2]];
        }

        containsPoint(point) {
            return point[0] >= this.min[0] && point[0] <= this.max[0] &&
                   point[1] >= this.min[1] && point[1] <= this.max[1] &&
                   point[2] >= this.min[2] && point[2] <= this.max[2];
        }
    }

    class WorkerSplatSubTree {

        constructor(maxDepth, maxCentersPerNode) {
            this.maxDepth = maxDepth;
            this.maxCentersPerNode = maxCentersPerNode;
            this.sceneDimensions = [];
            this.sceneMin = [];
            this.sceneMax = [];
            this.rootNode = null;
            this.addedIndexes = {};
            this.nodesWithIndexes = [];
            this.splatMesh = null;
            this.disposed = false;
        }

    }

    class WorkerSplatTreeNode {

        constructor(min, max, depth, id) {
            this.min = [min[0], min[1], min[2]];
            this.max = [max[0], max[1], max[2]];
            this.center = [(max[0] - min[0]) * 0.5 + min[0],
                           (max[1] - min[1]) * 0.5 + min[1],
                           (max[2] - min[2]) * 0.5 + min[2]];
            this.depth = depth;
            this.children = [];
            this.data = null;
            this.id = id || WorkerSplatTreeNodeIDGen++;
        }

    }

    processSplatTreeNode = function(tree, node, indexToCenter, sceneCenters) {
        const splatCount = node.data.indexes.length;

        if (splatCount < tree.maxCentersPerNode || node.depth > tree.maxDepth) {
            const newIndexes = [];
            for (let i = 0; i < node.data.indexes.length; i++) {
                if (!tree.addedIndexes[node.data.indexes[i]]) {
                    newIndexes.push(node.data.indexes[i]);
                    tree.addedIndexes[node.data.indexes[i]] = true;
                }
            }
            node.data.indexes = newIndexes;
            node.data.indexes.sort((a, b) => {
                if (a > b) return 1;
                else return -1;
            });
            tree.nodesWithIndexes.push(node);
            return;
        }

        const nodeDimensions = [node.max[0] - node.min[0],
                                node.max[1] - node.min[1],
                                node.max[2] - node.min[2]];
        const halfDimensions = [nodeDimensions[0] * 0.5,
                                nodeDimensions[1] * 0.5,
                                nodeDimensions[2] * 0.5];
        const nodeCenter = [node.min[0] + halfDimensions[0],
                            node.min[1] + halfDimensions[1],
                            node.min[2] + halfDimensions[2]];

        const childrenBounds = [
            // top section, clockwise from upper-left (looking from above, +Y)
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1], nodeCenter[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2]]),
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2]],
                           [nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2]]),

            // bottom section, clockwise from lower-left (looking from above, +Y)
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0], nodeCenter[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2]]),
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]],
                           [nodeCenter[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2]]),
        ];

        const splatCounts = [];
        const baseIndexes = [];
        for (let i = 0; i < childrenBounds.length; i++) {
            splatCounts[i] = 0;
            baseIndexes[i] = [];
        }

        const center = [0, 0, 0];
        for (let i = 0; i < splatCount; i++) {
            const splatGlobalIndex = node.data.indexes[i];
            const centerBase = indexToCenter[splatGlobalIndex];
            center[0] = sceneCenters[centerBase];
            center[1] = sceneCenters[centerBase + 1];
            center[2] = sceneCenters[centerBase + 2];
            for (let j = 0; j < childrenBounds.length; j++) {
                if (childrenBounds[j].containsPoint(center)) {
                    splatCounts[j]++;
                    baseIndexes[j].push(splatGlobalIndex);
                }
            }
        }

        for (let i = 0; i < childrenBounds.length; i++) {
            const childNode = new WorkerSplatTreeNode(childrenBounds[i].min, childrenBounds[i].max, node.depth + 1);
            childNode.data = {
                'indexes': baseIndexes[i]
            };
            node.children.push(childNode);
        }

        node.data = {};
        for (let child of node.children) {
            processSplatTreeNode(tree, child, indexToCenter, sceneCenters);
        }
        return;
    };

    const buildSubTree = (sceneCenters, maxDepth, maxCentersPerNode) => {

        const sceneMin = [0, 0, 0];
        const sceneMax = [0, 0, 0];
        const indexes = [];
        const centerCount = Math.floor(sceneCenters.length / 4);
        for ( let i = 0; i < centerCount; i ++) {
            const base = i * 4;
            const x = sceneCenters[base];
            const y = sceneCenters[base + 1];
            const z = sceneCenters[base + 2];
            const index = Math.round(sceneCenters[base + 3]);
            if (i === 0 || x < sceneMin[0]) sceneMin[0] = x;
            if (i === 0 || x > sceneMax[0]) sceneMax[0] = x;
            if (i === 0 || y < sceneMin[1]) sceneMin[1] = y;
            if (i === 0 || y > sceneMax[1]) sceneMax[1] = y;
            if (i === 0 || z < sceneMin[2]) sceneMin[2] = z;
            if (i === 0 || z > sceneMax[2]) sceneMax[2] = z;
            indexes.push(index);
        }
        const subTree = new WorkerSplatSubTree(maxDepth, maxCentersPerNode);
        subTree.sceneMin = sceneMin;
        subTree.sceneMax = sceneMax;
        subTree.rootNode = new WorkerSplatTreeNode(subTree.sceneMin, subTree.sceneMax, 0);
        subTree.rootNode.data = {
            'indexes': indexes
        };

        return subTree;
    };

    function createSplatTree(allCenters, maxDepth, maxCentersPerNode) {
        const indexToCenter = [];
        for (let sceneCenters of allCenters) {
            const centerCount = Math.floor(sceneCenters.length / 4);
            for ( let i = 0; i < centerCount; i ++) {
                const base = i * 4;
                const index = Math.round(sceneCenters[base + 3]);
                indexToCenter[index] = base;
            }
        }
        const subTrees = [];
        for (let sceneCenters of allCenters) {
            const subTree = buildSubTree(sceneCenters, maxDepth, maxCentersPerNode);
            subTrees.push(subTree);
            processSplatTreeNode(subTree, subTree.rootNode, indexToCenter, sceneCenters);
        }
        self.postMessage({
            'subTrees': subTrees
        });
    }

    self.onmessage = (e) => {
        if (e.data.process) {
            createSplatTree(e.data.process.centers, e.data.process.maxDepth, e.data.process.maxCentersPerNode);
        }
    };
}

function workerProcessCenters(splatTreeWorker, centers, transferBuffers, maxDepth, maxCentersPerNode) {
    splatTreeWorker.postMessage({
        'process': {
            'centers': centers,
            'maxDepth': maxDepth,
            'maxCentersPerNode': maxCentersPerNode
        }
    }, transferBuffers);
}

function checkAndCreateWorker() {
    const splatTreeWorker = new Worker(
        URL.createObjectURL(
            new Blob(['(', createSplatTreeWorker.toString(), ')(self)'], {
                type: 'application/javascript',
            }),
        ),
    );
    return splatTreeWorker;
}

/**
 * SplatTree: Octree tailored to splat data from a SplatMesh instance
 */
class SplatTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.subTrees = [];
        this.splatMesh = null;
    }


    dispose() {
        this.diposeSplatTreeWorker();
        this.disposed = true;
    }

    diposeSplatTreeWorker() {
        if (this.splatTreeWorker) this.splatTreeWorker.terminate();
        this.splatTreeWorker = null;
    };

    /**
     * Construct this instance of SplatTree from an instance of SplatMesh.
     *
     * @param {SplatMesh} splatMesh The instance of SplatMesh from which to construct this splat tree.
     * @param {function} filterFunc Optional function to filter out unwanted splats.
     * @param {function} onIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                   builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {undefined}
     */
    processSplatMesh = function(splatMesh, filterFunc = () => true, onIndexesUpload, onSplatTreeConstruction) {
        if (!this.splatTreeWorker) this.splatTreeWorker = checkAndCreateWorker();

        this.splatMesh = splatMesh;
        this.subTrees = [];
        const center = new THREE.Vector3();

        const addCentersForScene = (splatOffset, splatCount) => {
            const sceneCenters = new Float32Array(splatCount * 4);
            let addedCount = 0;
            for (let i = 0; i < splatCount; i++) {
                const globalSplatIndex = i + splatOffset;
                if (filterFunc(globalSplatIndex)) {
                    splatMesh.getSplatCenter(globalSplatIndex, center);
                    const addBase = addedCount * 4;
                    sceneCenters[addBase] = center.x;
                    sceneCenters[addBase + 1] = center.y;
                    sceneCenters[addBase + 2] = center.z;
                    sceneCenters[addBase + 3] = globalSplatIndex;
                    addedCount++;
                }
            }
            return sceneCenters;
        };

        return new Promise((resolve) => {

            const checkForEarlyExit = () => {
                if (this.disposed) {
                    this.diposeSplatTreeWorker();
                    resolve();
                    return true;
                }
                return false;
            };

            if (onIndexesUpload) onIndexesUpload(false);

            delayedExecute(() => {

                if (checkForEarlyExit()) return;

                const allCenters = [];
                if (splatMesh.dynamicMode) {
                    let splatOffset = 0;
                    for (let s = 0; s < splatMesh.scenes.length; s++) {
                        const scene = splatMesh.getScene(s);
                        const splatCount = scene.splatBuffer.getSplatCount();
                        const sceneCenters = addCentersForScene(splatOffset, splatCount);
                        allCenters.push(sceneCenters);
                        splatOffset += splatCount;
                    }
                } else {
                    const sceneCenters = addCentersForScene(0, splatMesh.getSplatCount());
                    allCenters.push(sceneCenters);
                }

                this.splatTreeWorker.onmessage = (e) => {

                    if (checkForEarlyExit()) return;

                    if (e.data.subTrees) {

                        if (onSplatTreeConstruction) onSplatTreeConstruction(false);

                        delayedExecute(() => {

                            if (checkForEarlyExit()) return;

                            for (let workerSubTree of e.data.subTrees) {
                                const convertedSubTree = SplatSubTree.convertWorkerSubTree(workerSubTree, splatMesh);
                                this.subTrees.push(convertedSubTree);
                            }
                            this.diposeSplatTreeWorker();

                            if (onSplatTreeConstruction) onSplatTreeConstruction(true);

                            delayedExecute(() => {
                                resolve();
                            });

                        });
                    }
                };

                delayedExecute(() => {
                    if (checkForEarlyExit()) return;
                    if (onIndexesUpload) onIndexesUpload(true);
                    const transferBuffers = allCenters.map((array) => array.buffer);
                    workerProcessCenters(this.splatTreeWorker, allCenters, transferBuffers, this.maxDepth, this.maxCentersPerNode);
                });

            });

        });

    };

    countLeaves() {

        let leafCount = 0;
        this.visitLeaves(() => {
            leafCount++;
        });

        return leafCount;
    }

    visitLeaves(visitFunc) {

        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        for (let subTree of this.subTrees) {
            visitLeavesFromNode(subTree.rootNode, visitFunc);
        }
    }

}

function WebGLExtensions( gl ) {

    const extensions = {};

    function getExtension( name ) {

        if ( extensions[name] !== undefined ) {

            return extensions[name];

        }

        let extension;

        switch ( name ) {

            case 'WEBGL_depth_texture':
                extension = gl.getExtension( 'WEBGL_depth_texture' ) || gl.getExtension( 'MOZ_WEBGL_depth_texture' ) ||
                            gl.getExtension( 'WEBKIT_WEBGL_depth_texture' );
                break;

            case 'EXT_texture_filter_anisotropic':
                extension = gl.getExtension( 'EXT_texture_filter_anisotropic' ) ||
                            gl.getExtension( 'MOZ_EXT_texture_filter_anisotropic' ) ||
                            gl.getExtension( 'WEBKIT_EXT_texture_filter_anisotropic' );
                break;

            case 'WEBGL_compressed_texture_s3tc':
                extension = gl.getExtension( 'WEBGL_compressed_texture_s3tc' ) ||
                            gl.getExtension( 'MOZ_WEBGL_compressed_texture_s3tc' ) ||
                            gl.getExtension( 'WEBKIT_WEBGL_compressed_texture_s3tc' );
                break;

            case 'WEBGL_compressed_texture_pvrtc':
                extension = gl.getExtension( 'WEBGL_compressed_texture_pvrtc' ) ||
                           gl.getExtension( 'WEBKIT_WEBGL_compressed_texture_pvrtc' );
                break;

            default:
                extension = gl.getExtension( name );

        }

        extensions[name] = extension;

        return extension;

    }

    return {

        has: function( name ) {

            return getExtension( name ) !== null;

        },

        init: function( capabilities ) {

            if ( capabilities.isWebGL2 ) {

                getExtension( 'EXT_color_buffer_float' );
                getExtension( 'WEBGL_clip_cull_distance' );

            } else {

                getExtension( 'WEBGL_depth_texture' );
                getExtension( 'OES_texture_float' );
                getExtension( 'OES_texture_half_float' );
                getExtension( 'OES_texture_half_float_linear' );
                getExtension( 'OES_standard_derivatives' );
                getExtension( 'OES_element_index_uint' );
                getExtension( 'OES_vertex_array_object' );
                getExtension( 'ANGLE_instanced_arrays' );

            }

            getExtension( 'OES_texture_float_linear' );
            getExtension( 'EXT_color_buffer_half_float' );
            getExtension( 'WEBGL_multisampled_render_to_texture' );

        },

        get: function( name ) {

            const extension = getExtension( name );

            if ( extension === null ) {

                console.warn( 'THREE.WebGLRenderer: ' + name + ' extension not supported.' );

            }

            return extension;

        }

    };

}

function WebGLCapabilities( gl, extensions, parameters ) {

    let maxAnisotropy;

    function getMaxAnisotropy() {

        if ( maxAnisotropy !== undefined ) return maxAnisotropy;

        if ( extensions.has( 'EXT_texture_filter_anisotropic' ) === true ) {

            const extension = extensions.get( 'EXT_texture_filter_anisotropic' );

            maxAnisotropy = gl.getParameter( extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT );

        } else {

            maxAnisotropy = 0;

        }

        return maxAnisotropy;

    }

    function getMaxPrecision( precision ) {

        if ( precision === 'highp' ) {

            if ( gl.getShaderPrecisionFormat( gl.VERTEX_SHADER, gl.HIGH_FLOAT ).precision > 0 &&
                gl.getShaderPrecisionFormat( gl.FRAGMENT_SHADER, gl.HIGH_FLOAT ).precision > 0 ) {

                return 'highp';

            }

            precision = 'mediump';

        }

        if ( precision === 'mediump' ) {

            if ( gl.getShaderPrecisionFormat( gl.VERTEX_SHADER, gl.MEDIUM_FLOAT ).precision > 0 &&
                gl.getShaderPrecisionFormat( gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT ).precision > 0 ) {

                return 'mediump';

            }

        }

        return 'lowp';

    }

    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl.constructor.name === 'WebGL2RenderingContext';

    let precision = parameters.precision !== undefined ? parameters.precision : 'highp';
    const maxPrecision = getMaxPrecision( precision );

    if ( maxPrecision !== precision ) {

        console.warn( 'THREE.WebGLRenderer:', precision, 'not supported, using', maxPrecision, 'instead.' );
        precision = maxPrecision;

    }

    const drawBuffers = isWebGL2 || extensions.has( 'WEBGL_draw_buffers' );

    const logarithmicDepthBuffer = parameters.logarithmicDepthBuffer === true;

    const maxTextures = gl.getParameter( gl.MAX_TEXTURE_IMAGE_UNITS );
    const maxVertexTextures = gl.getParameter( gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS );
    const maxTextureSize = gl.getParameter( gl.MAX_TEXTURE_SIZE );
    const maxCubemapSize = gl.getParameter( gl.MAX_CUBE_MAP_TEXTURE_SIZE );

    const maxAttributes = gl.getParameter( gl.MAX_VERTEX_ATTRIBS );
    const maxVertexUniforms = gl.getParameter( gl.MAX_VERTEX_UNIFORM_VECTORS );
    const maxVaryings = gl.getParameter( gl.MAX_VARYING_VECTORS );
    const maxFragmentUniforms = gl.getParameter( gl.MAX_FRAGMENT_UNIFORM_VECTORS );

    const vertexTextures = maxVertexTextures > 0;
    const floatFragmentTextures = isWebGL2 || extensions.has( 'OES_texture_float' );
    const floatVertexTextures = vertexTextures && floatFragmentTextures;

    const maxSamples = isWebGL2 ? gl.getParameter( gl.MAX_SAMPLES ) : 0;

    return {

        isWebGL2: isWebGL2,

        drawBuffers: drawBuffers,

        getMaxAnisotropy: getMaxAnisotropy,
        getMaxPrecision: getMaxPrecision,

        precision: precision,
        logarithmicDepthBuffer: logarithmicDepthBuffer,

        maxTextures: maxTextures,
        maxVertexTextures: maxVertexTextures,
        maxTextureSize: maxTextureSize,
        maxCubemapSize: maxCubemapSize,

        maxAttributes: maxAttributes,
        maxVertexUniforms: maxVertexUniforms,
        maxVaryings: maxVaryings,
        maxFragmentUniforms: maxFragmentUniforms,

        vertexTextures: vertexTextures,
        floatFragmentTextures: floatFragmentTextures,
        floatVertexTextures: floatVertexTextures,

        maxSamples: maxSamples

    };

}

const SceneRevealMode = {
    Default: 0,
    Gradual: 1,
    Instant: 2
};

const LogLevel = {
    None: 0,
    Error: 1,
    Warning: 2,
    Info: 3,
    Debug: 4
};

const dummyGeometry = new THREE.BufferGeometry();
const dummyMaterial = new THREE.MeshBasicMaterial();

const COVARIANCES_ELEMENTS_PER_SPLAT = 6;
const CENTER_COLORS_ELEMENTS_PER_SPLAT = 4;

const COVARIANCES_ELEMENTS_PER_TEXEL = 4;
const CENTER_COLORS_ELEMENTS_PER_TEXEL = 4;
const TRANSFORM_INDEXES_ELEMENTS_PER_TEXEL = 1;

const SCENE_FADEIN_RATE_FAST = 0.012;
const SCENE_FADEIN_RATE_GRADUAL = 0.003;

const VISIBLE_REGION_EXPANSION_DELTA = 1;

/**
 * SplatMesh: Container for one or more splat scenes, abstracting them into a single unified container for
 * splat data. Additionally contains data structures and code to make the splat data renderable as a Three.js mesh.
 */
class SplatMesh extends THREE.Mesh {

    constructor(dynamicMode = true, halfPrecisionCovariancesOnGPU = false, devicePixelRatio = 1,
                enableDistancesComputationOnGPU = true, integerBasedDistancesComputation = false,
                antialiased = false, maxScreenSpaceSplatSize = 2048, logLevel = LogLevel.None, sphericalHarmonicsDegree = 0) {
        super(dummyGeometry, dummyMaterial);
        // Reference to a Three.js renderer
        this.renderer = undefined;
        // Use 16-bit floating point values when storing splat covariance data in textures, instead of 32-bit
        this.halfPrecisionCovariancesOnGPU = halfPrecisionCovariancesOnGPU;
        // When 'dynamicMode' is true, scenes are assumed to be non-static. Dynamic scenes are handled differently
        // and certain optimizations cannot be made for them. Additionally, by default, all splat data retrieved from
        // this splat mesh will not have their scene transform applied to them if the splat mesh is dynamic. That
        // can be overriden via parameters to the individual functions that are used to retrieve splat data.
        this.dynamicMode = dynamicMode;
        // Ratio of the resolution in physical pixels to the resolution in CSS pixels for the current display device
        this.devicePixelRatio = devicePixelRatio;
        // Use a transform feedback to calculate splat distances from the camera
        this.enableDistancesComputationOnGPU = enableDistancesComputationOnGPU;
        // Use a faster integer-based approach for calculating splat distances from the camera
        this.integerBasedDistancesComputation = integerBasedDistancesComputation;
        // When true, will perform additional steps during rendering to address artifacts caused by the rendering of gaussians at a
        // substantially different resolution than that at which they were rendered during training. This will only work correctly
        // for models that were trained using a process that utilizes this compensation calculation. For more details:
        // https://github.com/nerfstudio-project/gsplat/pull/117
        // https://github.com/graphdeco-inria/gaussian-splatting/issues/294#issuecomment-1772688093
        this.antialiased = antialiased;
        // Specify the maximum clip space splat size, can help deal with large splats that get too unwieldy
        this.maxScreenSpaceSplatSize = maxScreenSpaceSplatSize;
        // The verbosity of console logging
        this.logLevel = logLevel;
        // Degree 0 means no spherical harmonics
        this.sphericalHarmonicsDegree = sphericalHarmonicsDegree;
        this.minSphericalHarmonicsDegree = 0;
        // The individual splat scenes stored in this splat mesh, each containing their own transform
        this.scenes = [];
        // Special octree tailored to SplatMesh instances
        this.splatTree = null;
        this.baseSplatTree = null;
        // Textures in which splat data will be stored for rendering
        this.splatDataTextures = {};
        this.distancesTransformFeedback = {
            'id': null,
            'vertexShader': null,
            'fragmentShader': null,
            'program': null,
            'centersBuffer': null,
            'transformIndexesBuffer': null,
            'outDistancesBuffer': null,
            'centersLoc': -1,
            'modelViewProjLoc': -1,
            'transformIndexesLoc': -1,
            'transformsLocs': []
        };
        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSceneIndexMap = [];

        this.lastBuildSplatCount = 0;
        this.lastBuildScenes = [];
        this.lastBuildMaxSplatCount = 0;
        this.lastBuildSceneCount = 0;
        this.firstRenderTime = -1;
        this.finalBuild = false;

        this.webGLUtils = null;

        this.boundingBox = new THREE.Box3();
        this.calculatedSceneCenter = new THREE.Vector3();
        this.maxSplatDistanceFromSceneCenter = 0;
        this.visibleRegionBufferRadius = 0;
        this.visibleRegionRadius = 0;
        this.visibleRegionFadeStartRadius = 0;
        this.visibleRegionChanging = false;

        this.splatScale = 1.0;
        this.pointCloudModeEnabled = false;

        this.disposed = false;
        this.lastRenderer = null;
        this.visible = false;
    }

    /**
     * Build the Three.js material that is used to render the splats.
     * @param {number} dynamicMode If true, it means the scene geometry represented by this splat mesh is not stationary or
     *                             that the splat count might change
     * @param {boolean} antialiased If true, calculate compensation factor to deal with gaussians being rendered at a significantly
     *                              different resolution than that of their training
     * @param {number} maxScreenSpaceSplatSize The maximum clip space splat size
     * @param {number} splatScale Value by which all splats are scaled in screen-space (default is 1.0)
     * @param {number} pointCloudModeEnabled Render all splats as screen-space circles
     * @param {number} maxSphericalHarmonicsDegree Degree of spherical harmonics to utilize in rendering splats
     * @return {THREE.ShaderMaterial}
     */
    static buildMaterial(dynamicMode = false, antialiased = false, maxScreenSpaceSplatSize = 2048,
                         splatScale = 1.0, pointCloudModeEnabled = false, maxSphericalHarmonicsDegree = 0) {

        // Contains the code to project 3D covariance to 2D and from there calculate the quad (using the eigen vectors of the
        // 2D covariance) that is ultimately rasterized
        let vertexShaderSource = `
            precision highp float;
            #include <common>

            attribute uint splatIndex;

            uniform highp sampler2D covariancesTexture;
            uniform highp usampler2D centersColorsTexture;
            uniform highp sampler2D sphericalHarmonicsTexture;`;

        if (dynamicMode) {
            vertexShaderSource += `
                uniform highp usampler2D transformIndexesTexture;
                uniform highp mat4 transforms[${Constants.MaxScenes}];
                uniform vec2 transformIndexesTextureSize;
            `;
        }

        vertexShaderSource += `
            uniform vec2 focal;
            uniform float orthoZoom;
            uniform int orthographicMode;
            uniform int pointCloudModeEnabled;
            uniform float inverseFocalAdjustment;
            uniform vec2 viewport;
            uniform vec2 basisViewport;
            uniform vec2 covariancesTextureSize;
            uniform vec2 centersColorsTextureSize;
            uniform int sphericalHarmonicsDegree;
            uniform vec2 sphericalHarmonicsTextureSize;
            uniform int sphericalHarmonics8BitMode;
            uniform float visibleRegionRadius;
            uniform float visibleRegionFadeStartRadius;
            uniform float firstRenderTime;
            uniform float currentTime;
            uniform int fadeInComplete;
            uniform vec3 sceneCenter;
            uniform float splatScale;

            varying vec4 vColor;
            varying vec2 vUv;

            varying vec2 vPosition;

            const float sqrt8 = sqrt(8.0);
            const float minAlpha = 1.0 / 255.0;

            const vec4 encodeNorm4 = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0);
            const uvec4 mask4 = uvec4(uint(0x000000FF), uint(0x0000FF00), uint(0x00FF0000), uint(0xFF000000));
            const uvec4 shift4 = uvec4(0, 8, 16, 24);
            vec4 uintToRGBAVec (uint u) {
               uvec4 urgba = mask4 & u;
               urgba = urgba >> shift4;
               vec4 rgba = vec4(urgba) * encodeNorm4;
               return rgba;
            }

            vec2 getDataUV(in int stride, in int offset, in vec2 dimensions) {
                vec2 samplerUV = vec2(0.0, 0.0);
                float d = float(splatIndex * uint(stride) + uint(offset)) / dimensions.x;
                samplerUV.y = float(floor(d)) / dimensions.y;
                samplerUV.x = fract(d);
                return samplerUV;
            }

            vec2 getDataUVF(in uint sIndex, in float stride, in uint offset, in vec2 dimensions) {
                vec2 samplerUV = vec2(0.0, 0.0);
                float d = float(uint(float(sIndex) * stride) + offset) / dimensions.x;
                samplerUV.y = float(floor(d)) / dimensions.y;
                samplerUV.x = fract(d);
                return samplerUV;
            }

            const float SH_C1 = 0.4886025119029199f;
            const float[5] SH_C2 = float[](1.0925484, -1.0925484, 0.3153916, -1.0925484, 0.5462742);

            const float SphericalHarmonics8BitCompressionRange = ${Constants.SphericalHarmonics8BitCompressionRange.toFixed(1)};
            const float SphericalHarmonics8BitCompressionHalfRange = SphericalHarmonics8BitCompressionRange / 2.0;
            const vec3 vec8BitSHShift = vec3(SphericalHarmonics8BitCompressionHalfRange);

            void main () {

                uint oddOffset = splatIndex & uint(0x00000001);
                uint doubleOddOffset = oddOffset * uint(2);
                bool isEven = oddOffset == uint(0);
                uint nearestEvenIndex = splatIndex - oddOffset;
                float fOddOffset = float(oddOffset);

                uvec4 sampledCenterColor = texture(centersColorsTexture, getDataUV(1, 0, centersColorsTextureSize));
                vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));`;

            if (dynamicMode) {
                vertexShaderSource += `
                    uint transformIndex = texture(transformIndexesTexture, getDataUV(1, 0, transformIndexesTextureSize)).r;
                    mat4 transform = transforms[transformIndex];
                    mat4 transformModelViewMatrix = modelViewMatrix * transform;
                `;
            } else {
                vertexShaderSource += `mat4 transformModelViewMatrix = modelViewMatrix;`;
            }

            vertexShaderSource += `
                vec4 viewCenter = transformModelViewMatrix * vec4(splatCenter, 1.0);

                vec4 clipCenter = projectionMatrix * viewCenter;

                float clip = 1.2 * clipCenter.w;
                if (clipCenter.z < -clip || clipCenter.x < -clip || clipCenter.x > clip || clipCenter.y < -clip || clipCenter.y > clip) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }

                vPosition = position.xy;
                vColor = uintToRGBAVec(sampledCenterColor.r);
            `;

            if (maxSphericalHarmonicsDegree >= 1) {

                vertexShaderSource += `   
                if (sphericalHarmonicsDegree >= 1) {
                `;

                if (dynamicMode) {
                    vertexShaderSource += `
                        mat4 mTransform = modelMatrix * transform;
                        vec3 worldViewDir = normalize(splatCenter - vec3(inverse(mTransform) * vec4(cameraPosition, 1.0)));
                    `;
                } else {
                    vertexShaderSource += `
                        vec3 worldViewDir = normalize(splatCenter - cameraPosition);
                    `;
                }

                if (maxSphericalHarmonicsDegree >= 2) {
                    vertexShaderSource += `
                        vec4 sampledSH0123 = texture(sphericalHarmonicsTexture, getDataUV(6, 0, sphericalHarmonicsTextureSize));
                        vec4 sampledSH4567 = texture(sphericalHarmonicsTexture, getDataUV(6, 1, sphericalHarmonicsTextureSize));
                        vec4 sampledSH891011 = texture(sphericalHarmonicsTexture, getDataUV(6, 2, sphericalHarmonicsTextureSize));
                        vec3 sh1 = sampledSH0123.rgb;
                        vec3 sh2 = vec3(sampledSH0123.a, sampledSH4567.rg);
                        vec3 sh3 = vec3(sampledSH4567.ba, sampledSH891011.r);
                    `;
                } else {
                    vertexShaderSource += `
                        vec2 shUV = getDataUVF(nearestEvenIndex, 2.5, doubleOddOffset, sphericalHarmonicsTextureSize);
                        vec4 sampledSH0123 = texture(sphericalHarmonicsTexture, shUV);
                        shUV = getDataUVF(nearestEvenIndex, 2.5, doubleOddOffset + uint(1), sphericalHarmonicsTextureSize);
                        vec4 sampledSH4567 = texture(sphericalHarmonicsTexture, shUV);
                        shUV = getDataUVF(nearestEvenIndex, 2.5, doubleOddOffset + uint(2), sphericalHarmonicsTextureSize);
                        vec4 sampledSH891011 = texture(sphericalHarmonicsTexture, shUV);

                        vec3 sh1 = vec3(sampledSH0123.rgb) * (1.0 - fOddOffset) + vec3(sampledSH0123.ba, sampledSH4567.r) * fOddOffset;
                        vec3 sh2 = vec3(sampledSH0123.a, sampledSH4567.rg) * (1.0 - fOddOffset) + vec3(sampledSH4567.gba) * fOddOffset;
                        vec3 sh3 = vec3(sampledSH4567.ba, sampledSH891011.r) * (1.0 - fOddOffset) + vec3(sampledSH891011.rgb) * fOddOffset;
                    `;
                }

                vertexShaderSource += `
                        if (sphericalHarmonics8BitMode == 1) {
                            sh1 = sh1 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                            sh2 = sh2 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                            sh3 = sh3 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                        }
                        float x = worldViewDir.x;
                        float y = worldViewDir.y;
                        float z = worldViewDir.z;
                        vColor.rgb += SH_C1 * (-sh1 * y + sh2 * z - sh3 * x);
                `;

                if (maxSphericalHarmonicsDegree >= 2) {

                    vertexShaderSource += `
                        if (sphericalHarmonicsDegree >= 2) {
                            float xx = x * x;
                            float yy = y * y;
                            float zz = z * z;
                            float xy = x * y;
                            float yz = y * z;
                            float xz = x * z;

                            vec4 sampledSH12131415 = texture(sphericalHarmonicsTexture, getDataUV(6, 3, sphericalHarmonicsTextureSize));
                            vec4 sampledSH16171819 = texture(sphericalHarmonicsTexture, getDataUV(6, 4, sphericalHarmonicsTextureSize));
                            vec4 sampledSH20212223 = texture(sphericalHarmonicsTexture, getDataUV(6, 5, sphericalHarmonicsTextureSize));

                            vec3 sh4 = sampledSH891011.gba;
                            vec3 sh5 = sampledSH12131415.rgb;
                            vec3 sh6 = vec3(sampledSH12131415.a, sampledSH16171819.rg);
                            vec3 sh7 = vec3(sampledSH16171819.ba, sampledSH20212223.r);
                            vec3 sh8 = sampledSH20212223.gba;

                            if (sphericalHarmonics8BitMode == 1) {
                                sh4 = sh4 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                                sh5 = sh5 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                                sh6 = sh6 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                                sh7 = sh7 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                                sh8 = sh8 * SphericalHarmonics8BitCompressionRange - vec8BitSHShift;
                            }

                            vColor.rgb +=
                                (SH_C2[0] * xy) * sh4 +
                                (SH_C2[1] * yz) * sh5 +
                                (SH_C2[2] * (2.0 * zz - xx - yy)) * sh6 +
                                (SH_C2[3] * xz) * sh7 +
                                (SH_C2[4] * (xx - yy)) * sh8;
                        }
                    `;
                }

                vertexShaderSource += `
               
                }

                `;
            }

            vertexShaderSource += `

                vec4 sampledCovarianceA = texture(covariancesTexture,
                                                  getDataUVF(nearestEvenIndex, 1.5, oddOffset, covariancesTextureSize));
                vec4 sampledCovarianceB = texture(covariancesTexture,
                                                  getDataUVF(nearestEvenIndex, 1.5, oddOffset + uint(1), covariancesTextureSize));

                vec3 cov3D_M11_M12_M13 = vec3(sampledCovarianceA.rgb) * (1.0 - fOddOffset) +
                                         vec3(sampledCovarianceA.ba, sampledCovarianceB.r) * fOddOffset;
                vec3 cov3D_M22_M23_M33 = vec3(sampledCovarianceA.a, sampledCovarianceB.rg) * (1.0 - fOddOffset) +
                                         vec3(sampledCovarianceB.gba) * fOddOffset;

                // Construct the 3D covariance matrix
                mat3 Vrk = mat3(
                    cov3D_M11_M12_M13.x, cov3D_M11_M12_M13.y, cov3D_M11_M12_M13.z,
                    cov3D_M11_M12_M13.y, cov3D_M22_M23_M33.x, cov3D_M22_M23_M33.y,
                    cov3D_M11_M12_M13.z, cov3D_M22_M23_M33.y, cov3D_M22_M23_M33.z
                );

                mat3 J;
                if (orthographicMode == 1) {
                    // Since the projection is linear, we don't need an approximation
                    J = transpose(mat3(orthoZoom, 0.0, 0.0,
                                       0.0, orthoZoom, 0.0,
                                       0.0, 0.0, 0.0));
                } else {
                    // Construct the Jacobian of the affine approximation of the projection matrix. It will be used to transform the
                    // 3D covariance matrix instead of using the actual projection matrix because that transformation would
                    // require a non-linear component (perspective division) which would yield a non-gaussian result.
                    float s = 1.0 / (viewCenter.z * viewCenter.z);
                    J = mat3(
                        focal.x / viewCenter.z, 0., -(focal.x * viewCenter.x) * s,
                        0., focal.y / viewCenter.z, -(focal.y * viewCenter.y) * s,
                        0., 0., 0.
                    );
                }

                // Concatenate the projection approximation with the model-view transformation
                mat3 W = transpose(mat3(transformModelViewMatrix));
                mat3 T = W * J;

                // Transform the 3D covariance matrix (Vrk) to compute the 2D covariance matrix
                mat3 cov2Dm = transpose(T) * Vrk * T;
                `;

            if (antialiased) {
                vertexShaderSource += `
                    float detOrig = cov2Dm[0][0] * cov2Dm[1][1] - cov2Dm[0][1] * cov2Dm[0][1];
                    cov2Dm[0][0] += 0.3;
                    cov2Dm[1][1] += 0.3;
                    float detBlur = cov2Dm[0][0] * cov2Dm[1][1] - cov2Dm[0][1] * cov2Dm[0][1];
                    float compensation = sqrt(max(detOrig / detBlur, 0.0));
                `;
            } else {
                vertexShaderSource += `
                    cov2Dm[0][0] += 0.3;
                    cov2Dm[1][1] += 0.3;
                    float compensation = 1.0;
                `;
            }

            vertexShaderSource += `

                vColor.a *= compensation;

                if (vColor.a < minAlpha) return;

                // We are interested in the upper-left 2x2 portion of the projected 3D covariance matrix because
                // we only care about the X and Y values. We want the X-diagonal, cov2Dm[0][0],
                // the Y-diagonal, cov2Dm[1][1], and the correlation between the two cov2Dm[0][1]. We don't
                // need cov2Dm[1][0] because it is a symetric matrix.
                vec3 cov2Dv = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);

                vec3 ndcCenter = clipCenter.xyz / clipCenter.w;

                // We now need to solve for the eigen-values and eigen vectors of the 2D covariance matrix
                // so that we can determine the 2D basis for the splat. This is done using the method described
                // here: https://people.math.harvard.edu/~knill/teaching/math21b2004/exhibits/2dmatrices/index.html
                // After calculating the eigen-values and eigen-vectors, we calculate the basis for rendering the splat
                // by normalizing the eigen-vectors and then multiplying them by (sqrt(8) * eigen-value), which is
                // equal to scaling them by sqrt(8) standard deviations.
                //
                // This is a different approach than in the original work at INRIA. In that work they compute the
                // max extents of the projected splat in screen space to form a screen-space aligned bounding rectangle
                // which forms the geometry that is actually rasterized. The dimensions of that bounding box are 3.0
                // times the maximum eigen-value, or 3 standard deviations. They then use the inverse 2D covariance
                // matrix (called 'conic') in the CUDA rendering thread to determine fragment opacity by calculating the
                // full gaussian: exp(-0.5 * (X - mean) * conic * (X - mean)) * splat opacity
                float a = cov2Dv.x;
                float d = cov2Dv.z;
                float b = cov2Dv.y;
                float D = a * d - b * b;
                float trace = a + d;
                float traceOver2 = 0.5 * trace;
                float term2 = sqrt(max(0.1f, traceOver2 * traceOver2 - D));
                float eigenValue1 = traceOver2 + term2;
                float eigenValue2 = traceOver2 - term2;

                if (pointCloudModeEnabled == 1) {
                    eigenValue1 = eigenValue2 = 0.2;
                }

                if (eigenValue2 <= 0.0) return;

                vec2 eigenVector1 = normalize(vec2(b, eigenValue1 - a));
                // since the eigen vectors are orthogonal, we derive the second one from the first
                vec2 eigenVector2 = vec2(eigenVector1.y, -eigenVector1.x);

                // We use sqrt(8) standard deviations instead of 3 to eliminate more of the splat with a very low opacity.
                vec2 basisVector1 = eigenVector1 * splatScale * min(sqrt8 * sqrt(eigenValue1), ${parseInt(maxScreenSpaceSplatSize)}.0);
                vec2 basisVector2 = eigenVector2 * splatScale * min(sqrt8 * sqrt(eigenValue2), ${parseInt(maxScreenSpaceSplatSize)}.0);

                if (fadeInComplete == 0) {
                    float opacityAdjust = 1.0;
                    float centerDist = length(splatCenter - sceneCenter);
                    float renderTime = max(currentTime - firstRenderTime, 0.0);

                    float fadeDistance = 0.75;
                    float distanceLoadFadeInFactor = step(visibleRegionFadeStartRadius, centerDist);
                    distanceLoadFadeInFactor = (1.0 - distanceLoadFadeInFactor) +
                                               (1.0 - clamp((centerDist - visibleRegionFadeStartRadius) / fadeDistance, 0.0, 1.0)) *
                                               distanceLoadFadeInFactor;
                    opacityAdjust *= distanceLoadFadeInFactor;
                    vColor.a *= opacityAdjust;
                }

                vec2 ndcOffset = vec2(vPosition.x * basisVector1 + vPosition.y * basisVector2) *
                                 basisViewport * 2.0 * inverseFocalAdjustment;

                vec4 quadPos = vec4(ndcCenter.xy + ndcOffset, ndcCenter.z, 1.0);
                gl_Position = quadPos;

                // Scale the position data we send to the fragment shader
                vPosition *= sqrt8;
            }`;

        const fragmentShaderSource = `
            precision highp float;
            #include <common>
 
            uniform vec3 debugColor;

            varying vec4 vColor;
            varying vec2 vUv;

            varying vec2 vPosition;

            void main () {
                // Compute the positional squared distance from the center of the splat to the current fragment.
                float A = dot(vPosition, vPosition);
                // Since the positional data in vPosition has been scaled by sqrt(8), the squared result will be
                // scaled by a factor of 8. If the squared result is larger than 8, it means it is outside the ellipse
                // defined by the rectangle formed by vPosition. It also means it's farther
                // away than sqrt(8) standard deviations from the mean.
                if (A > 8.0) discard;
                vec3 color = vColor.rgb;

                // Since the rendered splat is scaled by sqrt(8), the inverse covariance matrix that is part of
                // the gaussian formula becomes the identity matrix. We're then left with (X - mean) * (X - mean),
                // and since 'mean' is zero, we have X * X, which is the same as A:
                float opacity = exp(-0.5 * A) * vColor.a;

                gl_FragColor = vec4(color.rgb, opacity);
            }`;

        const uniforms = {
            'sceneCenter': {
                'type': 'v3',
                'value': new THREE.Vector3()
            },
            'fadeInComplete': {
                'type': 'i',
                'value': 0
            },
            'orthographicMode': {
                'type': 'i',
                'value': 0
            },
            'visibleRegionFadeStartRadius': {
                'type': 'f',
                'value': 0.0
            },
            'visibleRegionRadius': {
                'type': 'f',
                'value': 0.0
            },
            'currentTime': {
                'type': 'f',
                'value': 0.0
            },
            'firstRenderTime': {
                'type': 'f',
                'value': 0.0
            },
            'covariancesTexture': {
                'type': 't',
                'value': null
            },
            'centersColorsTexture': {
                'type': 't',
                'value': null
            },
            'sphericalHarmonicsTexture': {
                'type': 't',
                'value': null
            },
            'focal': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'orthoZoom': {
                'type': 'f',
                'value': 1.0
            },
            'inverseFocalAdjustment': {
                'type': 'f',
                'value': 1.0
            },
            'viewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'basisViewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'debugColor': {
                'type': 'v3',
                'value': new THREE.Color()
            },
            'covariancesTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'centersColorsTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'sphericalHarmonicsDegree': {
                'type': 'i',
                'value': maxSphericalHarmonicsDegree
            },
            'sphericalHarmonicsTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'sphericalHarmonics8BitMode': {
                'type': 'i',
                'value': 0
            },
            'splatScale': {
                'type': 'f',
                'value': splatScale
            },
            'pointCloudModeEnabled': {
                'type': 'i',
                'value': pointCloudModeEnabled ? 1 : 0
            }
        };

        if (dynamicMode) {
            uniforms['transformIndexesTexture'] = {
                'type': 't',
                'value': null
            };
            const transformMatrices = [];
            for (let i = 0; i < Constants.MaxScenes; i++) {
                transformMatrices.push(new THREE.Matrix4());
            }
            uniforms['transforms'] = {
                'type': 'mat4',
                'value': transformMatrices
            };
            uniforms['transformIndexesTextureSize'] = {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            };
        }

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: true,
            alphaTest: 1.0,
            blending: THREE.NormalBlending,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        return material;
    }

    /**
     * Build the Three.js geometry that will be used to render the splats. The geometry is instanced and is made up of
     * vertices for a single quad as well as an attribute buffer for the splat indexes.
     * @param {number} maxSplatCount The maximum number of splats that the geometry will need to accomodate
     * @return {THREE.InstancedBufferGeometry}
     */
    static buildGeomtery(maxSplatCount) {

        const baseGeometry = new THREE.BufferGeometry();
        baseGeometry.setIndex([0, 1, 2, 0, 2, 3]);

        // Vertices for the instanced quad
        const positionsArray = new Float32Array(4 * 3);
        const positions = new THREE.BufferAttribute(positionsArray, 3);
        baseGeometry.setAttribute('position', positions);
        positions.setXYZ(0, -1.0, -1.0, 0.0);
        positions.setXYZ(1, -1.0, 1.0, 0.0);
        positions.setXYZ(2, 1.0, 1.0, 0.0);
        positions.setXYZ(3, 1.0, -1.0, 0.0);
        positions.needsUpdate = true;

        const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);

        // Splat index buffer
        const splatIndexArray = new Uint32Array(maxSplatCount);
        const splatIndexes = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
        splatIndexes.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatIndex', splatIndexes);

        geometry.instanceCount = 0;

        return geometry;
    }

    /**
     * Build a container for each scene managed by this splat mesh based on an instance of SplatBuffer, along with optional
     * transform data (position, scale, rotation) passed to the splat mesh during the build process.
     * @param {Array<THREE.Matrix4>} splatBuffers SplatBuffer instances containing splats for each scene
     * @param {Array<object>} sceneOptions Array of options objects: {
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     * }
     * @return {Array<THREE.Matrix4>}
     */
    static buildScenes(splatBuffers, sceneOptions) {
        const scenes = [];
        scenes.length = splatBuffers.length;
        for (let i = 0; i < splatBuffers.length; i++) {
            const splatBuffer = splatBuffers[i];
            const options = sceneOptions[i] || {};
            let positionArray = options['position'] || [0, 0, 0];
            let rotationArray = options['rotation'] || [0, 0, 0, 1];
            let scaleArray = options['scale'] || [1, 1, 1];
            const position = new THREE.Vector3().fromArray(positionArray);
            const rotation = new THREE.Quaternion().fromArray(rotationArray);
            const scale = new THREE.Vector3().fromArray(scaleArray);
            scenes[i] = SplatMesh.createScene(splatBuffer, position, rotation, scale, options.splatAlphaRemovalThreshold || 1);
        }
        return scenes;
    }

    static createScene(splatBuffer, position, rotation, scale, minimumAlpha) {
        return new SplatScene(splatBuffer, position, rotation, scale, minimumAlpha);
    }

    /**
     * Build data structures that map global splat indexes (based on a unified index across all splat buffers) to
     * local data within a single scene.
     * @param {Array<SplatBuffer>} splatBuffers Instances of SplatBuffer off which to build the maps
     * @return {object}
     */
    static buildSplatIndexMaps(splatBuffers) {
        const localSplatIndexMap = [];
        const sceneIndexMap = [];
        let totalSplatCount = 0;
        for (let s = 0; s < splatBuffers.length; s++) {
            const splatBuffer = splatBuffers[s];
            const maxSplatCount = splatBuffer.getMaxSplatCount();
            for (let i = 0; i < maxSplatCount; i++) {
                localSplatIndexMap[totalSplatCount] = i;
                sceneIndexMap[totalSplatCount] = s;
                totalSplatCount++;
            }
        }
        return {
            localSplatIndexMap,
            sceneIndexMap
        };
    }

    /**
     * Build an instance of SplatTree (a specialized octree) for the given splat mesh.
     * @param {Array<number>} minAlphas Array of minimum splat slphas for each scene
     * @param {function} onSplatTreeIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                            builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {SplatTree}
     */
     buildSplatTree = function(minAlphas = [], onSplatTreeIndexesUpload, onSplatTreeConstruction) {
        return new Promise((resolve) => {
            this.disposeSplatTree();
            // TODO: expose SplatTree constructor parameters (maximumDepth and maxCentersPerNode) so that they can
            // be configured on a per-scene basis
            this.baseSplatTree = new SplatTree(8, 1000);
            const buildStartTime = performance.now();
            const splatColor = new THREE.Vector4();
            this.baseSplatTree.processSplatMesh(this, (splatIndex) => {
                this.getSplatColor(splatIndex, splatColor);
                const sceneIndex = this.getSceneIndexForSplat(splatIndex);
                const minAlpha = minAlphas[sceneIndex] || 1;
                return splatColor.w >= minAlpha;
            }, onSplatTreeIndexesUpload, onSplatTreeConstruction)
            .then(() => {
                const buildTime = performance.now() - buildStartTime;
                if (this.logLevel >= LogLevel.Info) console.log('SplatTree build: ' + buildTime + ' ms');
                if (this.disposed) {
                    resolve();
                } else {

                    this.splatTree = this.baseSplatTree;
                    this.baseSplatTree = null;

                    let leavesWithVertices = 0;
                    let avgSplatCount = 0;
                    let maxSplatCount = 0;
                    let nodeCount = 0;

                    this.splatTree.visitLeaves((node) => {
                        const nodeSplatCount = node.data.indexes.length;
                        if (nodeSplatCount > 0) {
                            avgSplatCount += nodeSplatCount;
                            maxSplatCount = Math.max(maxSplatCount, nodeSplatCount);
                            nodeCount++;
                            leavesWithVertices++;
                        }
                    });
                    if (this.logLevel >= LogLevel.Info) {
                        console.log(`SplatTree leaves: ${this.splatTree.countLeaves()}`);
                        console.log(`SplatTree leaves with splats:${leavesWithVertices}`);
                        avgSplatCount = avgSplatCount / nodeCount;
                        console.log(`Avg splat count per node: ${avgSplatCount}`);
                        console.log(`Total splat count: ${this.getSplatCount()}`);
                    }
                    resolve();
                }
            });
        });
    };

    /**
     * Construct this instance of SplatMesh.
     * @param {Array<SplatBuffer>} splatBuffers The base splat data, instances of SplatBuffer
     * @param {Array<object>} sceneOptions Dynamic options for each scene {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     * }
     * @param {boolean} keepSceneTransforms For a scene that already exists and is being overwritten, this flag
     *                                      says to keep the transform from the existing scene.
     * @param {boolean} finalBuild Will the splat mesh be in its final state after this build?
     * @param {function} onSplatTreeIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                            builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {object} Object containing info about the splats that are updated
     */
    build(splatBuffers, sceneOptions, keepSceneTransforms = true, finalBuild = false,
          onSplatTreeIndexesUpload, onSplatTreeConstruction) {

        this.sceneOptions = sceneOptions;
        this.finalBuild = finalBuild;

        const maxSplatCount = SplatMesh.getTotalMaxSplatCountForSplatBuffers(splatBuffers);

        const newScenes = SplatMesh.buildScenes(splatBuffers, sceneOptions);
        if (keepSceneTransforms) {
            for (let i = 0; i < this.scenes.length && i < newScenes.length; i++) {
                const newScene = newScenes[i];
                const existingScene = this.getScene(i);
                newScene.copyTransformData(existingScene);
            }
        }
        this.scenes = newScenes;

        let minSphericalHarmonicsDegree = 3;
        for (let splatBuffer of splatBuffers) {
            const splatBufferSphericalHarmonicsDegree = splatBuffer.getMinSphericalHarmonicsDegree();
            if (splatBufferSphericalHarmonicsDegree < minSphericalHarmonicsDegree) {
                minSphericalHarmonicsDegree = splatBufferSphericalHarmonicsDegree;
            }
        }
        this.minSphericalHarmonicsDegree = Math.min(minSphericalHarmonicsDegree, this.sphericalHarmonicsDegree);

        let splatBuffersChanged = false;
        if (splatBuffers.length !== this.lastBuildScenes.length) {
            splatBuffersChanged = true;
        } else {
            for (let i = 0; i < splatBuffers.length; i++) {
                const splatBuffer = splatBuffers[i];
                if (splatBuffer !== this.lastBuildScenes[i].splatBuffer) {
                    splatBuffersChanged = true;
                    break;
                }
            }
        }

        let isUpdateBuild = true;
        if (this.scenes.length !== 1 ||
            this.lastBuildSceneCount !== this.scenes.length ||
            this.lastBuildMaxSplatCount !== maxSplatCount ||
            splatBuffersChanged) {
                isUpdateBuild = false;
       }

       if (!isUpdateBuild) {
            this.boundingBox = new THREE.Box3();
            this.maxSplatDistanceFromSceneCenter = 0;
            this.visibleRegionBufferRadius = 0;
            this.visibleRegionRadius = 0;
            this.visibleRegionFadeStartRadius = 0;
            this.firstRenderTime = -1;
            this.lastBuildScenes = [];
            this.lastBuildSplatCount = 0;
            this.lastBuildMaxSplatCount = 0;
            this.disposeMeshData();
            this.geometry = SplatMesh.buildGeomtery(maxSplatCount);
            this.material = SplatMesh.buildMaterial(this.dynamicMode, this.antialiased, this.maxScreenSpaceSplatSize,
                                                    this.splatScale, this.pointCloudModeEnabled, this.minSphericalHarmonicsDegree);
            const indexMaps = SplatMesh.buildSplatIndexMaps(splatBuffers);
            this.globalSplatIndexToLocalSplatIndexMap = indexMaps.localSplatIndexMap;
            this.globalSplatIndexToSceneIndexMap = indexMaps.sceneIndexMap;
        }

        const splatCount = this.getSplatCount();
        if (this.enableDistancesComputationOnGPU) this.setupDistancesComputationTransformFeedback();
        const dataUpdateResults = this.refreshGPUDataFromSplatBuffers(isUpdateBuild);

        for (let i = 0; i < this.scenes.length; i++) {
            this.lastBuildScenes[i] = this.scenes[i];
        }
        this.lastBuildSplatCount = splatCount;
        this.lastBuildMaxSplatCount = this.getMaxSplatCount();
        this.lastBuildSceneCount = this.scenes.length;

        if (finalBuild && this.scenes.length > 0) {
            this.buildSplatTree(sceneOptions.map(options => options.splatAlphaRemovalThreshold || 1),
                                onSplatTreeIndexesUpload, onSplatTreeConstruction)
            .then(() => {
                if (this.onSplatTreeReadyCallback) this.onSplatTreeReadyCallback(this.splatTree);
            });
        }

        this.visible = (this.scenes.length > 0);

        return dataUpdateResults;
    }

    /**
     * Dispose all resources held by the splat mesh
     */
    dispose() {
        this.disposeMeshData();
        this.disposeTextures();
        this.disposeSplatTree();
        if (this.enableDistancesComputationOnGPU) {
            if (this.computeDistancesOnGPUSyncTimeout) {
                clearTimeout(this.computeDistancesOnGPUSyncTimeout);
                this.computeDistancesOnGPUSyncTimeout = null;
            }
            this.disposeDistancesComputationGPUResources();
        }
        this.scenes = [];
        this.distancesTransformFeedback = {
            'id': null,
            'vertexShader': null,
            'fragmentShader': null,
            'program': null,
            'centersBuffer': null,
            'transformIndexesBuffer': null,
            'outDistancesBuffer': null,
            'centersLoc': -1,
            'modelViewProjLoc': -1,
            'transformIndexesLoc': -1,
            'transformsLocs': []
        };
        this.renderer = null;

        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSceneIndexMap = [];

        this.lastBuildSplatCount = 0;
        this.lastBuildScenes = [];
        this.lastBuildMaxSplatCount = 0;
        this.lastBuildSceneCount = 0;
        this.firstRenderTime = -1;
        this.finalBuild = false;

        this.webGLUtils = null;

        this.boundingBox = new THREE.Box3();
        this.calculatedSceneCenter = new THREE.Vector3();
        this.maxSplatDistanceFromSceneCenter = 0;
        this.visibleRegionBufferRadius = 0;
        this.visibleRegionRadius = 0;
        this.visibleRegionFadeStartRadius = 0;
        this.visibleRegionChanging = false;

        this.splatScale = 1.0;
        this.pointCloudModeEnabled = false;

        this.disposed = true;
        this.lastRenderer = null;
        this.visible = false;
    }

    /**
     * Dispose of only the Three.js mesh resources (geometry, material, and texture)
     */
    disposeMeshData() {
        if (this.geometry && this.geometry !== dummyGeometry) {
            this.geometry.dispose();
            this.geometry = null;
        }
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
    }

    disposeTextures() {
        for (let textureKey in this.splatDataTextures) {
            if (this.splatDataTextures.hasOwnProperty(textureKey)) {
                const textureContainer = this.splatDataTextures[textureKey];
                if (textureContainer.texture) {
                    textureContainer.texture.dispose();
                    textureContainer.texture = null;
                }
            }
        }
        this.splatDataTextures = null;
    }

    disposeSplatTree() {
        if (this.splatTree) {
            this.splatTree.dispose();
            this.splatTree = null;
        } else if (this.baseSplatTree) {
            this.baseSplatTree.dispose();
            this.baseSplatTree = null;
        }
    }

    getSplatTree() {
        return this.splatTree;
    }

    onSplatTreeReady(callback) {
        this.onSplatTreeReadyCallback = callback;
    }

    /**
     * Get copies of data that are necessary for splat distance computation: splat center positions and splat
     * scene indexes (necessary for applying dynamic scene transformations during distance computation)
     * @param {*} start The index at which to start copying data
     * @param {*} end  The index at which to stop copying data
     * @return {object}
     */
    getDataForDistancesComputation(start, end) {
        const centers = this.integerBasedDistancesComputation ?
                        this.getIntegerCenters(start, end, true) :
                        this.getFloatCenters(start, end, true);
        const sceneIndexes = this.getSceneIndexes(start, end);
        return {
            centers,
            sceneIndexes
        };
    }

    /**
     * Refresh data textures and GPU buffers with splat data from the splat buffers belonging to this mesh.
     * @param {boolean} sinceLastBuildOnly Specify whether or not to only update for splats that have been added since the last build.
     * @return {object}
     */
    refreshGPUDataFromSplatBuffers(sinceLastBuildOnly) {
        const splatCount = this.getSplatCount();
        this.refreshDataTexturesFromSplatBuffers(sinceLastBuildOnly);
        const updateStart = sinceLastBuildOnly ? this.lastBuildSplatCount : 0;
        const { centers, sceneIndexes } = this.getDataForDistancesComputation(updateStart, splatCount - 1);
        if (this.enableDistancesComputationOnGPU) {
            this.refreshGPUBuffersForDistancesComputation(centers, sceneIndexes, sinceLastBuildOnly);
        }
        return {
            'from': updateStart,
            'to': splatCount - 1,
            'count': splatCount - updateStart,
            'centers': centers,
            'sceneIndexes': sceneIndexes
        };
    }

    /**
     * Update the GPU buffers that are used for computing splat distances on the GPU.
     * @param {Array<number>} centers Splat center positions
     * @param {Array<number>} sceneIndexes Indexes of the scene to which each splat belongs
     * @param {boolean} sinceLastBuildOnly Specify whether or not to only update for splats that have been added since the last build.
     */
    refreshGPUBuffersForDistancesComputation(centers, sceneIndexes, sinceLastBuildOnly = false) {
        const offset = sinceLastBuildOnly ? this.lastBuildSplatCount : 0;
        this.updateGPUCentersBufferForDistancesComputation(sinceLastBuildOnly, centers, offset);
        this.updateGPUTransformIndexesBufferForDistancesComputation(sinceLastBuildOnly, sceneIndexes, offset);
    }

    /**
     * Refresh data textures with data from the splat buffers for this mesh.
     * @param {boolean} sinceLastBuildOnly Specify whether or not to only update for splats that have been added since the last build.
     */
    refreshDataTexturesFromSplatBuffers(sinceLastBuildOnly) {
        if (!sinceLastBuildOnly) {
            this.setupDataTextures();
        } else {
            this.updateDataTextures();
        }
        this.updateVisibleRegion(sinceLastBuildOnly);
    }

    setupDataTextures() {
        const maxSplatCount = this.getMaxSplatCount();
        const splatCount = this.getSplatCount();

        this.disposeTextures();

        const computeDataTextureSize = (elementsPerTexel, elementsPerSplatl) => {
            const texSize = new THREE.Vector2(4096, 1024);
            while (texSize.x * texSize.y * elementsPerTexel < maxSplatCount * elementsPerSplatl) texSize.y *= 2;
            return texSize;
        };

        const covarianceCompressionLevel = this.getTargetCovarianceCompressionLevel();
        const sphericalHarmonicsCompressionLevel = this.getTargetSphericalHarmonicsCompressionLevel();

        const covariances = new Float32Array(maxSplatCount * COVARIANCES_ELEMENTS_PER_SPLAT);
        const centers = new Float32Array(maxSplatCount * 3);
        const colors = new Uint8Array(maxSplatCount * 4);

        let SphericalHarmonicsArrayType = Float32Array;
        if (sphericalHarmonicsCompressionLevel === 1) SphericalHarmonicsArrayType = Uint16Array;
        else if (sphericalHarmonicsCompressionLevel === 2) SphericalHarmonicsArrayType = Uint8Array;
        const sphericalHarmonicsComponentCount = getSphericalHarmonicsComponentCountForDegree(this.minSphericalHarmonicsDegree);
        let paddedSphericalHarmonicsComponentCount = sphericalHarmonicsComponentCount;
        if (paddedSphericalHarmonicsComponentCount % 2 !== 0) paddedSphericalHarmonicsComponentCount++;
        const sphericalHarmonics = this.minSphericalHarmonicsDegree ?
                                   new SphericalHarmonicsArrayType(maxSplatCount * sphericalHarmonicsComponentCount) : undefined;

        this.fillSplatDataArrays(covariances, centers, colors, sphericalHarmonics, undefined,
                                 covarianceCompressionLevel, sphericalHarmonicsCompressionLevel);

        // set up covariances data texture
        const covTexSize = computeDataTextureSize(COVARIANCES_ELEMENTS_PER_TEXEL, 6);
        let CovariancesDataType = covarianceCompressionLevel >= 1 ? Uint16Array : Float32Array;
        let covariancesTextureType = covarianceCompressionLevel >= 1 ? THREE.HalfFloatType : THREE.FloatType;
        const paddedCovariances = new CovariancesDataType(covTexSize.x * covTexSize.y * COVARIANCES_ELEMENTS_PER_TEXEL);
        paddedCovariances.set(covariances);

        const covTex = new THREE.DataTexture(paddedCovariances, covTexSize.x, covTexSize.y, THREE.RGBAFormat, covariancesTextureType);
        covTex.needsUpdate = true;
        this.material.uniforms.covariancesTexture.value = covTex;
        this.material.uniforms.covariancesTextureSize.value.copy(covTexSize);

        // set up centers/colors data texture
        const centersColsTexSize = computeDataTextureSize(CENTER_COLORS_ELEMENTS_PER_TEXEL, 4);
        const paddedCentersCols = new Uint32Array(centersColsTexSize.x * centersColsTexSize.y * CENTER_COLORS_ELEMENTS_PER_TEXEL);
        SplatMesh.updateCenterColorsPaddedData(0, splatCount, centers, colors, paddedCentersCols);

        const centersColsTex = new THREE.DataTexture(paddedCentersCols, centersColsTexSize.x, centersColsTexSize.y,
                                                     THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
        centersColsTex.internalFormat = 'RGBA32UI';
        centersColsTex.needsUpdate = true;
        this.material.uniforms.centersColorsTexture.value = centersColsTex;
        this.material.uniforms.centersColorsTextureSize.value.copy(centersColsTexSize);
        this.material.uniformsNeedUpdate = true;

        this.splatDataTextures = {
            'baseData': {
                'covariances': covariances,
                'centers': centers,
                'colors': colors,
                'sphericalHarmonics': sphericalHarmonics
            },
            'covariances': {
                'data': paddedCovariances,
                'texture': covTex,
                'size': covTexSize,
                'compressionLevel': covarianceCompressionLevel
            },
            'centerColors': {
                'data': paddedCentersCols,
                'texture': centersColsTex,
                'size': centersColsTexSize
            }
        };

        if (sphericalHarmonics) {
            const sphericalHarmonicsElementsPerTexel = 4;
            const sphericalHarmonicsTexSize = computeDataTextureSize(sphericalHarmonicsElementsPerTexel,
                                                                     paddedSphericalHarmonicsComponentCount);
            const paddedSHArraySize = sphericalHarmonicsTexSize.x * sphericalHarmonicsTexSize.y * sphericalHarmonicsElementsPerTexel;
            const paddedSHArray = new SphericalHarmonicsArrayType(paddedSHArraySize);
            for (let c = 0; c < splatCount; c++) {
                const srcBase = sphericalHarmonicsComponentCount * c;
                const destBase = paddedSphericalHarmonicsComponentCount * c;
                for (let i = 0; i < sphericalHarmonicsComponentCount; i++) {
                    paddedSHArray[destBase + i] = sphericalHarmonics[srcBase + i];
                }
            }

            const textureType = sphericalHarmonicsCompressionLevel === 2 ? THREE.UnsignedByteType : THREE.HalfFloatType;
            const sphericalHarmonicsTex = new THREE.DataTexture(paddedSHArray, sphericalHarmonicsTexSize.x,
                                                                sphericalHarmonicsTexSize.y, THREE.RGBAFormat, textureType);
            sphericalHarmonicsTex.needsUpdate = true;
            this.material.uniforms.sphericalHarmonicsTexture.value = sphericalHarmonicsTex;
            this.material.uniforms.sphericalHarmonicsTextureSize.value.copy(sphericalHarmonicsTexSize);
            if (sphericalHarmonicsCompressionLevel === 2) {
                this.material.uniforms.sphericalHarmonics8BitMode.value = 1;
            }
            this.material.uniformsNeedUpdate = true;

            this.splatDataTextures['sphericalHarmonics'] = {
                'componentCount': sphericalHarmonicsComponentCount,
                'paddedComponentCount': paddedSphericalHarmonicsComponentCount,
                'data': paddedSHArray,
                'texture': sphericalHarmonicsTex,
                'size': sphericalHarmonicsTexSize,
                'compressionLevel': sphericalHarmonicsCompressionLevel
            };
        }

        if (this.dynamicMode) {
            const transformIndexesTexSize = computeDataTextureSize(TRANSFORM_INDEXES_ELEMENTS_PER_TEXEL, 4);
            const paddedTransformIndexes = new Uint32Array(transformIndexesTexSize.x *
                                                           transformIndexesTexSize.y * TRANSFORM_INDEXES_ELEMENTS_PER_TEXEL);
            for (let c = 0; c < splatCount; c++) paddedTransformIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
            const transformIndexesTexture = new THREE.DataTexture(paddedTransformIndexes, transformIndexesTexSize.x,
                                                                  transformIndexesTexSize.y, THREE.RedIntegerFormat,
                                                                  THREE.UnsignedIntType);
            transformIndexesTexture.internalFormat = 'R32UI';
            transformIndexesTexture.needsUpdate = true;
            this.material.uniforms.transformIndexesTexture.value = transformIndexesTexture;
            this.material.uniforms.transformIndexesTextureSize.value.copy(transformIndexesTexSize);
            this.material.uniformsNeedUpdate = true;
            this.splatDataTextures['tansformIndexes'] = {
                'data': paddedTransformIndexes,
                'texture': transformIndexesTexture,
                'size': transformIndexesTexSize
            };
        }
    }

    updateDataTextures() {
        const splatCount = this.getSplatCount();
        const covarianceCompressionLevel = this.splatDataTextures['covariances'].compressionLevel;

        const sphericalHarmonicsTextureDesc = this.splatDataTextures['sphericalHarmonics'];
        const sphericalHarmonicsCompressionLevel = sphericalHarmonicsTextureDesc ? sphericalHarmonicsTextureDesc.compressionLevel : 0;

        this.fillSplatDataArrays(this.splatDataTextures.baseData.covariances,
                                 this.splatDataTextures.baseData.centers, this.splatDataTextures.baseData.colors,
                                 this.splatDataTextures.baseData.sphericalHarmonics, undefined, covarianceCompressionLevel,
                                 sphericalHarmonicsCompressionLevel, this.lastBuildSplatCount, splatCount - 1, this.lastBuildSplatCount);

        const covariancesTextureDescriptor = this.splatDataTextures['covariances'];
        const paddedCovariances = covariancesTextureDescriptor.data;
        const covariancesTexture = covariancesTextureDescriptor.texture;
        const covarancesStartSplat = this.lastBuildSplatCount * COVARIANCES_ELEMENTS_PER_SPLAT;
        const covariancesEndSplat = splatCount * COVARIANCES_ELEMENTS_PER_SPLAT;
        for (let i = covarancesStartSplat; i < covariancesEndSplat; i++) {
            const covariance = this.splatDataTextures.baseData.covariances[i];
            paddedCovariances[i] = covariance;
        }
        const covariancesTextureProps = this.renderer ? this.renderer.properties.get(covariancesTexture) : null;
        if (!covariancesTextureProps || !covariancesTextureProps.__webglTexture) {
            covariancesTexture.needsUpdate = true;
        } else {
            const covaranceBytesPerElement = covarianceCompressionLevel ? 2 : 4;
            this.updateDataTexture(paddedCovariances, covariancesTextureDescriptor, covariancesTextureProps,
                                   COVARIANCES_ELEMENTS_PER_TEXEL, COVARIANCES_ELEMENTS_PER_SPLAT, covaranceBytesPerElement,
                                   this.lastBuildSplatCount, splatCount - 1);
        }

        const centerColorsTextureDescriptor = this.splatDataTextures['centerColors'];
        const paddedCenterColors = centerColorsTextureDescriptor.data;
        const centerColorsTexture = centerColorsTextureDescriptor.texture;
        SplatMesh.updateCenterColorsPaddedData(this.lastBuildSplatCount, splatCount, this.splatDataTextures.baseData.centers,
                                               this.splatDataTextures.baseData.colors, paddedCenterColors);
        const centerColorsTextureProps = this.renderer ? this.renderer.properties.get(centerColorsTexture) : null;
        if (!centerColorsTextureProps || !centerColorsTextureProps.__webglTexture) {
            centerColorsTexture.needsUpdate = true;
        } else {
            this.updateDataTexture(paddedCenterColors, centerColorsTextureDescriptor, centerColorsTextureProps,
                                   CENTER_COLORS_ELEMENTS_PER_TEXEL, CENTER_COLORS_ELEMENTS_PER_SPLAT, 4,
                                   this.lastBuildSplatCount, splatCount - 1);
        }

        if (this.splatDataTextures.baseData.sphericalHarmonics) {
            const sphericalHarmonicsComponentCount = sphericalHarmonicsTextureDesc.componentCount;
            const paddedSphericalHarmonicsComponentCount = sphericalHarmonicsTextureDesc.paddedComponentCount;
            const paddedSHArray = sphericalHarmonicsTextureDesc.data;
            for (let c = this.lastBuildSplatCount; c < splatCount; c++) {
                const srcBase = sphericalHarmonicsComponentCount * c;
                const destBase = paddedSphericalHarmonicsComponentCount * c;
                for (let i = 0; i < sphericalHarmonicsComponentCount; i++) {
                    paddedSHArray[destBase + i] = this.splatDataTextures.baseData.sphericalHarmonics[srcBase + i];
                }
            }

            const sphericalHarmonicsTex = sphericalHarmonicsTextureDesc.texture;
            const sphericalHarmonicsTextureProps = this.renderer ? this.renderer.properties.get(sphericalHarmonicsTex) : null;
            if (!sphericalHarmonicsTextureProps || !sphericalHarmonicsTextureProps.__webglTexture) {
                sphericalHarmonicsTex.needsUpdate = true;
            } else {
                const sphericalHarmonicsElementsPerTexel = 4;
                let sphericalHarmonicsBytesPerElement = 4;
                if (sphericalHarmonicsCompressionLevel === 1) sphericalHarmonicsBytesPerElement = 2;
                else if (sphericalHarmonicsCompressionLevel === 2) sphericalHarmonicsBytesPerElement = 1;
                this.updateDataTexture(paddedSHArray, sphericalHarmonicsTextureDesc, sphericalHarmonicsTextureProps,
                                       sphericalHarmonicsElementsPerTexel, paddedSphericalHarmonicsComponentCount,
                                       sphericalHarmonicsBytesPerElement, this.lastBuildSplatCount, splatCount - 1);
            }
        }

        if (this.dynamicMode) {
            const transformIndexesTexDesc = this.splatDataTextures['tansformIndexes'];
            const paddedTransformIndexes = transformIndexesTexDesc.data;
            for (let c = this.lastBuildSplatCount; c < splatCount; c++) {
                paddedTransformIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
            }

            const transformIndexesTexture = transformIndexesTexDesc.texture;
            const transformIndexesTextureProps = this.renderer ? this.renderer.properties.get(transformIndexesTexture) : null;
            if (!transformIndexesTextureProps || !transformIndexesTextureProps.__webglTexture) {
                transformIndexesTexture.needsUpdate = true;
            } else {
                this.updateDataTexture(paddedTransformIndexes, transformIndexesTexDesc, transformIndexesTextureProps, 1, 1, 1,
                                       this.lastBuildSplatCount, splatCount - 1);
            }
        }
    }

    getTargetCovarianceCompressionLevel() {
        return this.halfPrecisionCovariancesOnGPU ? 1 : 0;
    }

    getTargetSphericalHarmonicsCompressionLevel() {
        return Math.max(1, this.getMaximumSplatBufferCompressionLevel());
    }

    getMaximumSplatBufferCompressionLevel() {
        let maxCompressionLevel;
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            if (i === 0 || splatBuffer.compressionLevel > maxCompressionLevel) {
                maxCompressionLevel = splatBuffer.compressionLevel;
            }
        }
        return maxCompressionLevel;
    }

    getMinimumSplatBufferCompressionLevel() {
        let minCompressionLevel;
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            if (i === 0 || splatBuffer.compressionLevel < minCompressionLevel) {
                minCompressionLevel = splatBuffer.compressionLevel;
            }
        }
        return minCompressionLevel;
    }

    static computeTextureUpdateRegion(startSplat, endSplat, textureWidth, elementsPerTexel, elementsPerSplat) {
        const texelsPerSplat = elementsPerSplat / elementsPerTexel;

        const startSplatTexels = startSplat * texelsPerSplat;
        const startRow = Math.floor(startSplatTexels / textureWidth);
        const startRowElement = startRow * textureWidth * elementsPerTexel;

        const endSplatTexels = endSplat * texelsPerSplat;
        const endRow = Math.floor(endSplatTexels / textureWidth);
        const endRowEndElement = endRow * textureWidth * elementsPerTexel + (textureWidth * elementsPerTexel);

        return {
            'dataStart': startRowElement,
            'dataEnd': endRowEndElement,
            'startRow': startRow,
            'endRow': endRow
        };
    }

    updateDataTexture(paddedData, textureDesc, textureProps, elementsPerTexel, elementsPerSplat, bytesPerElement, from, to) {
        const gl = this.renderer.getContext();
        const updateRegion = SplatMesh.computeTextureUpdateRegion(from, to, textureDesc.size.x, elementsPerTexel, elementsPerSplat);
        const updateElementCount = updateRegion.dataEnd - updateRegion.dataStart;
        const updateDataView = new paddedData.constructor(paddedData.buffer,
                                                          updateRegion.dataStart * bytesPerElement, updateElementCount);
        const updateHeight = updateRegion.endRow - updateRegion.startRow + 1;
        const dataTexture = textureDesc.texture;
        const glType = this.webGLUtils.convert(dataTexture.type);
        const glFormat = this.webGLUtils.convert(dataTexture.format, dataTexture.colorSpace);
        const currentTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D, textureProps.__webglTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, updateRegion.startRow,
                         textureDesc.size.x, updateHeight, glFormat, glType, updateDataView);
        gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    }


    static updateCenterColorsPaddedData(to, from, centers, colors, paddedCenterColors) {
        for (let c = to; c < from; c++) {
            const colorsBase = c * 4;
            const centersBase = c * 3;
            const centerColorsBase = c * 4;
            paddedCenterColors[centerColorsBase] = rgbaArrayToInteger(colors, colorsBase);
            paddedCenterColors[centerColorsBase + 1] = uintEncodedFloat(centers[centersBase]);
            paddedCenterColors[centerColorsBase + 2] = uintEncodedFloat(centers[centersBase + 1]);
            paddedCenterColors[centerColorsBase + 3] = uintEncodedFloat(centers[centersBase + 2]);
        }
    }

    updateVisibleRegion(sinceLastBuildOnly) {
        const splatCount = this.getSplatCount();
        const tempCenter = new THREE.Vector3();
        if (!sinceLastBuildOnly) {
            const avgCenter = new THREE.Vector3();
            this.scenes.forEach((scene) => {
                avgCenter.add(scene.splatBuffer.sceneCenter);
            });
            avgCenter.multiplyScalar(1.0 / this.scenes.length);
            this.calculatedSceneCenter.copy(avgCenter);
            this.material.uniforms.sceneCenter.value.copy(this.calculatedSceneCenter);
            this.material.uniformsNeedUpdate = true;
        }

        const startSplatFormMaxDistanceCalc = sinceLastBuildOnly ? this.lastBuildSplatCount : 0;
        for (let i = startSplatFormMaxDistanceCalc; i < splatCount; i++) {
            this.getSplatCenter(i, tempCenter, false);
            const distFromCSceneCenter = tempCenter.sub(this.calculatedSceneCenter).length();
            if (distFromCSceneCenter > this.maxSplatDistanceFromSceneCenter) this.maxSplatDistanceFromSceneCenter = distFromCSceneCenter;
        }

        if (this.maxSplatDistanceFromSceneCenter - this.visibleRegionBufferRadius > VISIBLE_REGION_EXPANSION_DELTA) {
            this.visibleRegionBufferRadius = this.maxSplatDistanceFromSceneCenter;
            this.visibleRegionRadius = Math.max(this.visibleRegionBufferRadius - VISIBLE_REGION_EXPANSION_DELTA, 0.0);
        }
        if (this.finalBuild) this.visibleRegionRadius = this.visibleRegionBufferRadius = this.maxSplatDistanceFromSceneCenter;
        this.updateVisibleRegionFadeDistance();
    }

    updateVisibleRegionFadeDistance(sceneRevealMode = SceneRevealMode.Default) {
        const fastFadeRate = SCENE_FADEIN_RATE_FAST;
        const gradualFadeRate = SCENE_FADEIN_RATE_GRADUAL;
        const defaultFadeInRate = this.finalBuild ? fastFadeRate : gradualFadeRate;
        const fadeInRate = sceneRevealMode === SceneRevealMode.Default ? defaultFadeInRate : gradualFadeRate;
        this.visibleRegionFadeStartRadius = (this.visibleRegionRadius - this.visibleRegionFadeStartRadius) *
                                             fadeInRate + this.visibleRegionFadeStartRadius;
        const fadeInPercentage = (this.visibleRegionBufferRadius > 0) ?
                                 (this.visibleRegionFadeStartRadius / this.visibleRegionBufferRadius) : 0;
        const fadeInComplete = fadeInPercentage > 0.99;
        const shaderFadeInComplete = (fadeInComplete || sceneRevealMode === SceneRevealMode.Instant) ? 1 : 0;

        this.material.uniforms.visibleRegionFadeStartRadius.value = this.visibleRegionFadeStartRadius;
        this.material.uniforms.visibleRegionRadius.value = this.visibleRegionRadius;
        this.material.uniforms.firstRenderTime.value = this.firstRenderTime;
        this.material.uniforms.currentTime.value = performance.now();
        this.material.uniforms.fadeInComplete.value = shaderFadeInComplete;
        this.material.uniformsNeedUpdate = true;
        this.visibleRegionChanging = !fadeInComplete;
    }

    /**
     * Set the indexes of splats that should be rendered; should be sorted in desired render order.
     * @param {Uint32Array} globalIndexes Sorted index list of splats to be rendered
     * @param {number} renderSplatCount Total number of splats to be rendered. Necessary because we may not want to render
     *                                  every splat.
     */
    updateRenderIndexes(globalIndexes, renderSplatCount) {
        const geometry = this.geometry;
        geometry.attributes.splatIndex.set(globalIndexes);
        geometry.attributes.splatIndex.needsUpdate = true;
        if (renderSplatCount > 0 && this.firstRenderTime === -1) this.firstRenderTime = performance.now();
        geometry.instanceCount = renderSplatCount;
    }

    /**
     * Update the transforms for each scene in this splat mesh from their individual components (position,
     * quaternion, and scale)
     */
    updateTransforms() {
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            scene.updateTransform();
        }
    }

    updateUniforms = function() {

        const viewport = new THREE.Vector2();

        return function(renderDimensions, cameraFocalLengthX, cameraFocalLengthY,
                        orthographicMode, orthographicZoom, inverseFocalAdjustment) {
            const splatCount = this.getSplatCount();
            if (splatCount > 0) {
                viewport.set(renderDimensions.x * this.devicePixelRatio,
                             renderDimensions.y * this.devicePixelRatio);
                this.material.uniforms.viewport.value.copy(viewport);
                this.material.uniforms.basisViewport.value.set(1.0 / viewport.x, 1.0 / viewport.y);
                this.material.uniforms.focal.value.set(cameraFocalLengthX, cameraFocalLengthY);
                this.material.uniforms.orthographicMode.value = orthographicMode ? 1 : 0;
                this.material.uniforms.orthoZoom.value = orthographicZoom;
                this.material.uniforms.inverseFocalAdjustment.value = inverseFocalAdjustment;
                if (this.dynamicMode) {
                    for (let i = 0; i < this.scenes.length; i++) {
                        this.material.uniforms.transforms.value[i].copy(this.getScene(i).transform);
                    }
                }
                this.material.uniformsNeedUpdate = true;
            }
        };

    }();

    setSplatScale(splatScale = 1) {
        this.splatScale = splatScale;
        this.material.uniforms.splatScale.value = splatScale;
        this.material.uniformsNeedUpdate = true;
    }

    getSplatScale() {
        return this.splatScale;
    }

    setPointCloudModeEnabled(enabled) {
        this.pointCloudModeEnabled = enabled;
        this.material.uniforms.pointCloudModeEnabled.value = enabled ? 1 : 0;
        this.material.uniformsNeedUpdate = true;
    }

    getPointCloudModeEnabled() {
        return this.pointCloudModeEnabled;
    }

    getSplatDataTextures() {
        return this.splatDataTextures;
    }

    getSplatCount() {
        return SplatMesh.getTotalSplatCountForScenes(this.scenes);
    }

    static getTotalSplatCountForScenes(scenes) {
        let totalSplatCount = 0;
        for (let scene of scenes) {
            if (scene && scene.splatBuffer) totalSplatCount += scene.splatBuffer.getSplatCount();
        }
        return totalSplatCount;
    }

    static getTotalSplatCountForSplatBuffers(splatBuffers) {
        let totalSplatCount = 0;
        for (let splatBuffer of splatBuffers) totalSplatCount += splatBuffer.getSplatCount();
        return totalSplatCount;
    }

    getMaxSplatCount() {
        return SplatMesh.getTotalMaxSplatCountForScenes(this.scenes);
    }

    static getTotalMaxSplatCountForScenes(scenes) {
        let totalSplatCount = 0;
        for (let scene of scenes) {
            if (scene && scene.splatBuffer) totalSplatCount += scene.splatBuffer.getMaxSplatCount();
        }
        return totalSplatCount;
    }

    static getTotalMaxSplatCountForSplatBuffers(splatBuffers) {
        let totalSplatCount = 0;
        for (let splatBuffer of splatBuffers) totalSplatCount += splatBuffer.getMaxSplatCount();
        return totalSplatCount;
    }

    disposeDistancesComputationGPUResources() {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        if (this.distancesTransformFeedback.vao) {
            gl.deleteVertexArray(this.distancesTransformFeedback.vao);
            this.distancesTransformFeedback.vao = null;
        }
        if (this.distancesTransformFeedback.program) {
            gl.deleteProgram(this.distancesTransformFeedback.program);
            gl.deleteShader(this.distancesTransformFeedback.vertexShader);
            gl.deleteShader(this.distancesTransformFeedback.fragmentShader);
            this.distancesTransformFeedback.program = null;
            this.distancesTransformFeedback.vertexShader = null;
            this.distancesTransformFeedback.fragmentShader = null;
        }
        this.disposeDistancesComputationGPUBufferResources();
        if (this.distancesTransformFeedback.id) {
            gl.deleteTransformFeedback(this.distancesTransformFeedback.id);
            this.distancesTransformFeedback.id = null;
        }
    }

    disposeDistancesComputationGPUBufferResources() {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        if (this.distancesTransformFeedback.centersBuffer) {
            this.distancesTransformFeedback.centersBuffer = null;
            gl.deleteBuffer(this.distancesTransformFeedback.centersBuffer);
        }
        if (this.distancesTransformFeedback.outDistancesBuffer) {
            gl.deleteBuffer(this.distancesTransformFeedback.outDistancesBuffer);
            this.distancesTransformFeedback.outDistancesBuffer = null;
        }
    }

    /**
     * Set the Three.js renderer used by this splat mesh
     * @param {THREE.WebGLRenderer} renderer Instance of THREE.WebGLRenderer
     */
    setRenderer(renderer) {
        if (renderer !== this.renderer) {
            this.renderer = renderer;
            const gl = this.renderer.getContext();
            const extensions = new WebGLExtensions(gl);
            const capabilities = new WebGLCapabilities(gl, extensions, {});
            extensions.init(capabilities);
            this.webGLUtils = new THREE.WebGLUtils(gl, extensions, capabilities);
            if (this.enableDistancesComputationOnGPU && this.getSplatCount() > 0) {
                this.setupDistancesComputationTransformFeedback();
                const { centers, sceneIndexes } = this.getDataForDistancesComputation(0, this.getSplatCount() - 1);
                this.refreshGPUBuffersForDistancesComputation(centers, sceneIndexes);
            }
        }
    }

    setupDistancesComputationTransformFeedback = function() {

        let currentMaxSplatCount;

        return function() {
            const maxSplatCount = this.getMaxSplatCount();

            if (!this.renderer) return;

            const rebuildGPUObjects = (this.lastRenderer !== this.renderer);
            const rebuildBuffers = currentMaxSplatCount !== maxSplatCount;

            if (!rebuildGPUObjects && !rebuildBuffers) return;

            if (rebuildGPUObjects) {
                this.disposeDistancesComputationGPUResources();
            } else if (rebuildBuffers) {
                this.disposeDistancesComputationGPUBufferResources();
            }

            const gl = this.renderer.getContext();

            const createShader = (gl, type, source) => {
                const shader = gl.createShader(type);
                if (!shader) {
                    console.error('Fatal error: gl could not create a shader object.');
                    return null;
                }

                gl.shaderSource(shader, source);
                gl.compileShader(shader);

                const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
                if (!compiled) {
                    let typeName = 'unknown';
                    if (type === gl.VERTEX_SHADER) typeName = 'vertex shader';
                    else if (type === gl.FRAGMENT_SHADER) typeName = 'fragement shader';
                    const errors = gl.getShaderInfoLog(shader);
                    console.error('Failed to compile ' + typeName + ' with these errors:' + errors);
                    gl.deleteShader(shader);
                    return null;
                }

                return shader;
            };

            let vsSource;
            if (this.integerBasedDistancesComputation) {
                vsSource =
                `#version 300 es
                in ivec4 center;
                flat out int distance;`;
                if (this.dynamicMode) {
                    vsSource += `
                        in uint transformIndex;
                        uniform ivec4 transforms[${Constants.MaxScenes}];
                        void main(void) {
                            ivec4 transform = transforms[transformIndex];
                            distance = center.x * transform.x + center.y * transform.y + center.z * transform.z + transform.w * center.w;
                        }
                    `;
                } else {
                    vsSource += `
                        uniform ivec3 modelViewProj;
                        void main(void) {
                            distance = center.x * modelViewProj.x + center.y * modelViewProj.y + center.z * modelViewProj.z;
                        }
                    `;
                }
            } else {
                vsSource =
                `#version 300 es
                in vec4 center;
                flat out float distance;`;
                if (this.dynamicMode) {
                    vsSource += `
                        in uint transformIndex;
                        uniform mat4 transforms[${Constants.MaxScenes}];
                        void main(void) {
                            vec4 transformedCenter = transforms[transformIndex] * vec4(center.xyz, 1.0);
                            distance = transformedCenter.z;
                        }
                    `;
                } else {
                    vsSource += `
                        uniform vec3 modelViewProj;
                        void main(void) {
                            distance = center.x * modelViewProj.x + center.y * modelViewProj.y + center.z * modelViewProj.z;
                        }
                    `;
                }
            }

            const fsSource =
            `#version 300 es
                precision lowp float;
                out vec4 fragColor;
                void main(){}
            `;

            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);
            const currentProgramDeleted = currentProgram ? gl.getProgramParameter(currentProgram, gl.DELETE_STATUS) : false;

            if (rebuildGPUObjects) {
                this.distancesTransformFeedback.vao = gl.createVertexArray();
            }

            gl.bindVertexArray(this.distancesTransformFeedback.vao);

            if (rebuildGPUObjects) {
                const program = gl.createProgram();
                const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
                const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
                if (!vertexShader || !fragmentShader) {
                    throw new Error('Could not compile shaders for distances computation on GPU.');
                }
                gl.attachShader(program, vertexShader);
                gl.attachShader(program, fragmentShader);
                gl.transformFeedbackVaryings(program, ['distance'], gl.SEPARATE_ATTRIBS);
                gl.linkProgram(program);

                const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
                if (!linked) {
                    const error = gl.getProgramInfoLog(program);
                    console.error('Fatal error: Failed to link program: ' + error);
                    gl.deleteProgram(program);
                    gl.deleteShader(fragmentShader);
                    gl.deleteShader(vertexShader);
                    throw new Error('Could not link shaders for distances computation on GPU.');
                }

                this.distancesTransformFeedback.program = program;
                this.distancesTransformFeedback.vertexShader = vertexShader;
                this.distancesTransformFeedback.vertexShader = fragmentShader;
            }

            gl.useProgram(this.distancesTransformFeedback.program);

            this.distancesTransformFeedback.centersLoc =
                gl.getAttribLocation(this.distancesTransformFeedback.program, 'center');
            if (this.dynamicMode) {
                this.distancesTransformFeedback.transformIndexesLoc =
                    gl.getAttribLocation(this.distancesTransformFeedback.program, 'transformIndex');
                for (let i = 0; i < this.scenes.length; i++) {
                    this.distancesTransformFeedback.transformsLocs[i] =
                        gl.getUniformLocation(this.distancesTransformFeedback.program, `transforms[${i}]`);
                }
            } else {
                this.distancesTransformFeedback.modelViewProjLoc =
                    gl.getUniformLocation(this.distancesTransformFeedback.program, 'modelViewProj');
            }

            if (rebuildGPUObjects || rebuildBuffers) {
                this.distancesTransformFeedback.centersBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);
                gl.enableVertexAttribArray(this.distancesTransformFeedback.centersLoc);
                if (this.integerBasedDistancesComputation) {
                    gl.vertexAttribIPointer(this.distancesTransformFeedback.centersLoc, 4, gl.INT, 0, 0);
                } else {
                    gl.vertexAttribPointer(this.distancesTransformFeedback.centersLoc, 4, gl.FLOAT, false, 0, 0);
                }

                if (this.dynamicMode) {
                    this.distancesTransformFeedback.transformIndexesBuffer = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.transformIndexesBuffer);
                    gl.enableVertexAttribArray(this.distancesTransformFeedback.transformIndexesLoc);
                    gl.vertexAttribIPointer(this.distancesTransformFeedback.transformIndexesLoc, 1, gl.UNSIGNED_INT, 0, 0);
                }
            }

            if (rebuildGPUObjects || rebuildBuffers) {
                this.distancesTransformFeedback.outDistancesBuffer = gl.createBuffer();
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.outDistancesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, maxSplatCount * 4, gl.STATIC_READ);

            if (rebuildGPUObjects) {
                this.distancesTransformFeedback.id = gl.createTransformFeedback();
            }
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distancesTransformFeedback.id);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distancesTransformFeedback.outDistancesBuffer);

            if (currentProgram && currentProgramDeleted !== true) gl.useProgram(currentProgram);
            if (currentVao) gl.bindVertexArray(currentVao);

            this.lastRenderer = this.renderer;
            currentMaxSplatCount = maxSplatCount;
        };

    }();

    /**
     * Refresh GPU buffers used for computing splat distances with centers data from the scenes for this mesh.
     * @param {boolean} isUpdate Specify whether or not to update the GPU buffer or to initialize & fill
     * @param {Array<number>} centers The splat centers data
     * @param {number} offsetSplats Offset in the GPU buffer at which to start updating data, specified in splats
     */
    updateGPUCentersBufferForDistancesComputation(isUpdate, centers, offsetSplats) {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        gl.bindVertexArray(this.distancesTransformFeedback.vao);

        const ArrayType = this.integerBasedDistancesComputation ? Uint32Array : Float32Array;
        const attributeBytesPerCenter = 16;
        const subBufferOffset = offsetSplats * attributeBytesPerCenter;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);

        if (isUpdate) {
            gl.bufferSubData(gl.ARRAY_BUFFER, subBufferOffset, centers);
        } else {
            const maxArray = new ArrayType(this.getMaxSplatCount() * attributeBytesPerCenter);
            maxArray.set(centers);
            gl.bufferData(gl.ARRAY_BUFFER, maxArray, gl.STATIC_DRAW);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (currentVao) gl.bindVertexArray(currentVao);
    }

    /**
     * Refresh GPU buffers used for pre-computing splat distances with centers data from the scenes for this mesh.
     * @param {boolean} isUpdate Specify whether or not to update the GPU buffer or to initialize & fill
     * @param {Array<number>} transformIndexes The splat transform indexes
     * @param {number} offsetSplats Offset in the GPU buffer at which to start updating data, specified in splats
     */
    updateGPUTransformIndexesBufferForDistancesComputation(isUpdate, transformIndexes, offsetSplats) {

        if (!this.renderer || !this.dynamicMode) return;

        const gl = this.renderer.getContext();

        const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        gl.bindVertexArray(this.distancesTransformFeedback.vao);

        const subBufferOffset = offsetSplats * 4;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.transformIndexesBuffer);

        if (isUpdate) {
            gl.bufferSubData(gl.ARRAY_BUFFER, subBufferOffset, transformIndexes);
        } else {
            const maxArray = new Uint32Array(this.getMaxSplatCount() * 4);
            maxArray.set(transformIndexes);
            gl.bufferData(gl.ARRAY_BUFFER, maxArray, gl.STATIC_DRAW);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (currentVao) gl.bindVertexArray(currentVao);
    }

    /**
     * Get a typed array containing a mapping from global splat indexes to their scene index.
     * @param {number} start Starting splat index to store
     * @param {number} end Ending splat index to store
     * @return {Uint32Array}
     */
    getSceneIndexes(start, end) {

        let sceneIndexes;
        const fillCount = end - start + 1;
        sceneIndexes = new Uint32Array(fillCount);
        for (let i = start; i <= end; i++) {
            sceneIndexes[i] = this.globalSplatIndexToSceneIndexMap[i];
        }

        return sceneIndexes;
    }

    /**
     * Fill 'array' with the transforms for each scene in this splat mesh.
     * @param {Array} array Empty array to be filled with scene transforms. If not empty, contents will be overwritten.
     */
    fillTransformsArray = function() {

        const tempArray = [];

        return function(array) {
            if (tempArray.length !== array.length) tempArray.length = array.length;
            for (let i = 0; i < this.scenes.length; i++) {
                const sceneTransform = this.getScene(i).transform;
                const sceneTransformElements = sceneTransform.elements;
                for (let j = 0; j < 16; j++) {
                    tempArray[i * 16 + j] = sceneTransformElements[j];
                }
            }
            array.set(tempArray);
        };

    }();

    computeDistancesOnGPU = function() {

        const tempMatrix = new THREE.Matrix4();

        return function(modelViewProjMatrix, outComputedDistances) {
            if (!this.renderer) return;

            // console.time("gpu_compute_distances");
            const gl = this.renderer.getContext();

            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);
            const currentProgramDeleted = currentProgram ? gl.getProgramParameter(currentProgram, gl.DELETE_STATUS) : false;

            gl.bindVertexArray(this.distancesTransformFeedback.vao);
            gl.useProgram(this.distancesTransformFeedback.program);

            gl.enable(gl.RASTERIZER_DISCARD);

            if (this.dynamicMode) {
                for (let i = 0; i < this.scenes.length; i++) {
                    tempMatrix.copy(this.getScene(i).transform);
                    tempMatrix.premultiply(modelViewProjMatrix);

                    if (this.integerBasedDistancesComputation) {
                        const iTempMatrix = SplatMesh.getIntegerMatrixArray(tempMatrix);
                        const iTransform = [iTempMatrix[2], iTempMatrix[6], iTempMatrix[10], iTempMatrix[14]];
                        gl.uniform4i(this.distancesTransformFeedback.transformsLocs[i], iTransform[0], iTransform[1],
                                                                                        iTransform[2], iTransform[3]);
                    } else {
                        gl.uniformMatrix4fv(this.distancesTransformFeedback.transformsLocs[i], false, tempMatrix.elements);
                    }
                }
            } else {
                if (this.integerBasedDistancesComputation) {
                    const iViewProjMatrix = SplatMesh.getIntegerMatrixArray(modelViewProjMatrix);
                    const iViewProj = [iViewProjMatrix[2], iViewProjMatrix[6], iViewProjMatrix[10]];
                    gl.uniform3i(this.distancesTransformFeedback.modelViewProjLoc, iViewProj[0], iViewProj[1], iViewProj[2]);
                } else {
                    const viewProj = [modelViewProjMatrix.elements[2], modelViewProjMatrix.elements[6], modelViewProjMatrix.elements[10]];
                    gl.uniform3f(this.distancesTransformFeedback.modelViewProjLoc, viewProj[0], viewProj[1], viewProj[2]);
                }
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);
            gl.enableVertexAttribArray(this.distancesTransformFeedback.centersLoc);
            if (this.integerBasedDistancesComputation) {
                gl.vertexAttribIPointer(this.distancesTransformFeedback.centersLoc, 4, gl.INT, 0, 0);
            } else {
                gl.vertexAttribPointer(this.distancesTransformFeedback.centersLoc, 4, gl.FLOAT, false, 0, 0);
            }

            if (this.dynamicMode) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.transformIndexesBuffer);
                gl.enableVertexAttribArray(this.distancesTransformFeedback.transformIndexesLoc);
                gl.vertexAttribIPointer(this.distancesTransformFeedback.transformIndexesLoc, 1, gl.UNSIGNED_INT, 0, 0);
            }

            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distancesTransformFeedback.id);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distancesTransformFeedback.outDistancesBuffer);

            gl.beginTransformFeedback(gl.POINTS);
            gl.drawArrays(gl.POINTS, 0, this.getSplatCount());
            gl.endTransformFeedback();

            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

            gl.disable(gl.RASTERIZER_DISCARD);

            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();

            const promise = new Promise((resolve) => {
                const checkSync = () => {
                    if (this.disposed) {
                        resolve();
                    } else {
                        const timeout = 0;
                        const bitflags = 0;
                        const status = gl.clientWaitSync(sync, bitflags, timeout);
                        switch (status) {
                            case gl.TIMEOUT_EXPIRED:
                                this.computeDistancesOnGPUSyncTimeout = setTimeout(checkSync);
                                return this.computeDistancesOnGPUSyncTimeout;
                            case gl.WAIT_FAILED:
                                throw new Error('should never get here');
                            default:
                                this.computeDistancesOnGPUSyncTimeout = null;
                                gl.deleteSync(sync);
                                const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
                                gl.bindVertexArray(this.distancesTransformFeedback.vao);
                                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.outDistancesBuffer);
                                gl.getBufferSubData(gl.ARRAY_BUFFER, 0, outComputedDistances);
                                gl.bindBuffer(gl.ARRAY_BUFFER, null);

                                if (currentVao) gl.bindVertexArray(currentVao);

                                // console.timeEnd("gpu_compute_distances");

                                resolve();
                        }
                    }
                };
                this.computeDistancesOnGPUSyncTimeout = setTimeout(checkSync);
            });

            if (currentProgram && currentProgramDeleted !== true) gl.useProgram(currentProgram);
            if (currentVao) gl.bindVertexArray(currentVao);

            return promise;
        };

    }();

    /**
     * Given a global splat index, return corresponding local data (splat buffer, index of splat in that splat
     * buffer, and the corresponding transform)
     * @param {number} globalIndex Global splat index
     * @param {object} paramsObj Object in which to store local data
     * @param {boolean} returnSceneTransform By default, the transform of the scene to which the splat at 'globalIndex' belongs will be
     *                                       returned via the 'sceneTransform' property of 'paramsObj' only if the splat mesh is static.
     *                                       If 'returnSceneTransform' is true, the 'sceneTransform' property will always contain the scene
     *                                       transform, and if 'returnSceneTransform' is false, the 'sceneTransform' property will always
     *                                       be null.
     */
    getLocalSplatParameters(globalIndex, paramsObj, returnSceneTransform) {
        if (returnSceneTransform === undefined || returnSceneTransform === null) {
            returnSceneTransform = this.dynamicMode ? false : true;
        }
        paramsObj.splatBuffer = this.getSplatBufferForSplat(globalIndex);
        paramsObj.localIndex = this.getSplatLocalIndex(globalIndex);
        paramsObj.sceneTransform = returnSceneTransform ? this.getSceneTransformForSplat(globalIndex) : null;
    }

    /**
     * Fill arrays with splat data and apply transforms if appropriate. Each array is optional.
     * @param {Float32Array} covariances Target storage for splat covariances
     * @param {Float32Array} centers Target storage for splat centers
     * @param {Uint8Array} colors Target storage for splat colors
     * @param {Float32Array} sphericalHarmonics Target storage for spherical harmonics
     * @param {boolean} applySceneTransform By default, scene transforms are applied to relevant splat data only if the splat mesh is
     *                                      static. If 'applySceneTransform' is true, scene transforms will always be applied and if
     *                                      it is false, they will never be applied. If undefined, the default behavior will apply.
     * @param {number} covarianceCompressionLevel The compression level for covariances in the destination array
     * @param {number} sphericalHarmonicsCompressionLevel The compression level for spherical harmonics in the destination array
     * @param {number} srcStart The start location from which to pull source data
     * @param {number} srcEnd The end location from which to pull source data
     * @param {number} destStart The start location from which to write data
     */
    fillSplatDataArrays(covariances, centers, colors, sphericalHarmonics, applySceneTransform,
                        covarianceCompressionLevel = 0, sphericalHarmonicsCompressionLevel = 1, srcStart, srcEnd, destStart = 0) {

        for (let i = 0; i < this.scenes.length; i++) {
            if (applySceneTransform === undefined || applySceneTransform === null) {
                applySceneTransform = this.dynamicMode ? false : true;
            }

            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            const sceneTransform = applySceneTransform ? scene.transform : null;
            if (covariances) {
                splatBuffer.fillSplatCovarianceArray(covariances, sceneTransform,
                                                     srcStart, srcEnd, destStart, covarianceCompressionLevel);
            }
            if (centers) splatBuffer.fillSplatCenterArray(centers, sceneTransform, srcStart, srcEnd, destStart);
            if (colors) splatBuffer.fillSplatColorArray(colors, scene.minimumAlpha, srcStart, srcEnd, destStart);
            if (sphericalHarmonics) {
                splatBuffer.fillSphericalHarmonicsArray(sphericalHarmonics, this.minSphericalHarmonicsDegree,
                                                        sceneTransform, srcStart, srcEnd, destStart, sphericalHarmonicsCompressionLevel);
            }
            destStart += splatBuffer.getSplatCount();
        }
    }

    /**
     * Convert splat centers, which are floating point values, to an array of integers and multiply
     * each by 1000. Centers will get transformed as appropriate before conversion to integer.
     * @param {number} start The index at which to start retrieving data
     * @param {number} end The index at which to stop retrieving data
     * @param {boolean} padFour Enforce alignment of 4 by inserting a 1 after every 3 values
     * @return {Int32Array}
     */
    getIntegerCenters(start, end, padFour = false) {
        const splatCount = end - start + 1;
        const floatCenters = new Float32Array(splatCount * 3);
        this.fillSplatDataArrays(null, floatCenters, null, null, undefined, undefined, undefined, start);
        let intCenters;
        let componentCount = padFour ? 4 : 3;
        intCenters = new Int32Array(splatCount * componentCount);
        for (let i = 0; i < splatCount; i++) {
            for (let t = 0; t < 3; t++) {
                intCenters[i * componentCount + t] = Math.round(floatCenters[i * 3 + t] * 1000.0);
            }
            if (padFour) intCenters[i * componentCount + 3] = 1000;
        }
        return intCenters;
    }

    /**
     * Returns an array of splat centers, transformed as appropriate, optionally padded.
     * @param {number} start The index at which to start retrieving data
     * @param {number} end The index at which to stop retrieving data
     * @param {boolean} padFour Enforce alignment of 4 by inserting a 1 after every 3 values
     * @return {Float32Array}
     */
    getFloatCenters(start, end, padFour = false) {
        const splatCount = end - start + 1;
        const floatCenters = new Float32Array(splatCount * 3);
        this.fillSplatDataArrays(null, floatCenters, null, null, undefined, undefined, undefined, start);
        if (!padFour) return floatCenters;
        let paddedFloatCenters = new Float32Array(splatCount * 4);
        for (let i = 0; i < splatCount; i++) {
            for (let t = 0; t < 3; t++) {
                paddedFloatCenters[i * 4 + t] = floatCenters[i * 3 + t];
            }
            paddedFloatCenters[i * 4 + 3] = 1.0;
        }
        return paddedFloatCenters;
    }

    /**
     * Get the center for a splat, transformed as appropriate.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector3} outCenter THREE.Vector3 instance in which to store splat center
     * @param {boolean} applySceneTransform By default, if the splat mesh is static, the transform of the scene to which the splat at
     *                                      'globalIndex' belongs will be applied to the splat center. If 'applySceneTransform' is true,
     *                                      the scene transform will always be applied and if 'applySceneTransform' is false, the
     *                                      scene transform will never be applied. If undefined, the default behavior will apply.
     */
    getSplatCenter = function() {

        const paramsObj = {};

        return function(globalIndex, outCenter, applySceneTransform) {
            this.getLocalSplatParameters(globalIndex, paramsObj, applySceneTransform);
            paramsObj.splatBuffer.getSplatCenter(paramsObj.localIndex, outCenter, paramsObj.sceneTransform);
        };

    }();

    /**
     * Get the scale and rotation for a splat, transformed as appropriate.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector3} outScale THREE.Vector3 instance in which to store splat scale
     * @param {THREE.Quaternion} outRotation THREE.Quaternion instance in which to store splat rotation
     * @param {boolean} applySceneTransform By default, if the splat mesh is static, the transform of the scene to which the splat at
     *                                      'globalIndex' belongs will be applied to the splat scale and rotation. If
     *                                      'applySceneTransform' is true, the scene transform will always be applied and if
     *                                      'applySceneTransform' is false, the scene transform will never be applied. If undefined,
     *                                      the default behavior will apply.
     */
    getSplatScaleAndRotation = function() {

        const paramsObj = {};

        return function(globalIndex, outScale, outRotation, applySceneTransform) {
            this.getLocalSplatParameters(globalIndex, paramsObj, applySceneTransform);
            paramsObj.splatBuffer.getSplatScaleAndRotation(paramsObj.localIndex, outScale, outRotation, paramsObj.sceneTransform);
        };

    }();

    /**
     * Get the color for a splat.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector4} outColor THREE.Vector4 instance in which to store splat color
     */
    getSplatColor = function() {

        const paramsObj = {};

        return function(globalIndex, outColor) {
            this.getLocalSplatParameters(globalIndex, paramsObj);
            paramsObj.splatBuffer.getSplatColor(paramsObj.localIndex, outColor);
        };

    }();

    /**
     * Store the transform of the scene at 'sceneIndex' in 'outTransform'.
     * @param {number} sceneIndex Index of the desired scene
     * @param {THREE.Matrix4} outTransform Instance of THREE.Matrix4 in which to store the scene's transform
     */
    getSceneTransform(sceneIndex, outTransform) {
        const scene = this.getScene(sceneIndex);
        scene.updateTransform();
        outTransform.copy(scene.transform);
    }

    /**
     * Get the scene at 'sceneIndex'.
     * @param {number} sceneIndex Index of the desired scene
     * @return {SplatScene}
     */
    getScene(sceneIndex) {
        if (sceneIndex < 0 || sceneIndex >= this.scenes.length) {
            throw new Error('SplatMesh::getScene() -> Invalid scene index.');
        }
        return this.scenes[sceneIndex];
    }

    getSplatBufferForSplat(globalIndex) {
        return this.getScene(this.globalSplatIndexToSceneIndexMap[globalIndex]).splatBuffer;
    }

    getSceneIndexForSplat(globalIndex) {
        return this.globalSplatIndexToSceneIndexMap[globalIndex];
    }

    getSceneTransformForSplat(globalIndex) {
        return this.getScene(this.globalSplatIndexToSceneIndexMap[globalIndex]).transform;
    }

    getSplatLocalIndex(globalIndex) {
        return this.globalSplatIndexToLocalSplatIndexMap[globalIndex];
    }

    static getIntegerMatrixArray(matrix) {
        const matrixElements = matrix.elements;
        const intMatrixArray = [];
        for (let i = 0; i < 16; i++) {
            intMatrixArray[i] = Math.round(matrixElements[i] * 1000.0);
        }
        return intMatrixArray;
    }
}

var SorterWasm = "AGFzbQEAAAAADAZkeWxpbmsAAAAAAAEbA2AAAGAQf39/f39/f39/f39/f39/fwBgAAF/AhIBA2VudgZtZW1vcnkCAwCAgAQDBAMAAQIHOQMRX193YXNtX2NhbGxfY3RvcnMAAAtzb3J0SW5kZXhlcwABE2Vtc2NyaXB0ZW5fdGxzX2luaXQAAgrHEAMDAAELuxAFAXwDewJ/A30CfiALIAprIQwCQCAOBEAgDQRAQfj///8HIQ5BiICAgHghDSALIAxNDQIgDCEBA0AgAyABQQJ0IgVqIAIgACAFaigCAEECdGooAgAiBTYCACAFIA4gBSAOSBshDiAFIA0gBSANShshDSABQQFqIgEgC0cNAAsMAgsgDwRAQfj///8HIQ5BiICAgHghDSALIAxNDQJBfyEPIAwhAgNAIA8gByAAIAJBAnQiFGooAgAiFUECdGooAgAiCkcEQAJ+IAX9CQIIIAggCkEGdGoiD/0JAgAgDyoCEP0gASAPKgIg/SACIA8qAjD9IAP95gEgBf0JAhggD/0JAgQgDyoCFP0gASAPKgIk/SACIA8qAjT9IAP95gH95AEgBf0JAiggD/0JAgggDyoCGP0gASAPKgIo/SACIA8qAjj9IAP95gH95AEgBf0JAjggD/0JAgwgDyoCHP0gASAPKgIs/SACIA8qAjz9IAP95gH95AEiEf0fArv9FCAR/R8Du/0iAf0MAAAAAABAj0AAAAAAAECPQCIS/fIBIhP9IQEiEJlEAAAAAAAA4ENjBEAgELAMAQtCgICAgICAgICAfwshGQJ+IBP9IQAiEJlEAAAAAAAA4ENjBEAgELAMAQtCgICAgICAgICAfwv9EiETAn4gEf0fALv9FCAR/R8Bu/0iASAS/fIBIhH9IQEiEJlEAAAAAAAA4ENjBEAgELAMAQtCgICAgICAgICAfwshGiATIBn9HgEhEgJ+IBH9IQAiEJlEAAAAAAAA4ENjBEAgELAMAQtCgICAgICAgICAfwv9EiAa/R4BIBL9DQABAgMICQoLEBESExgZGhshEiAKIQ8LIAMgFGogASAVQQR0av0AAAAgEv21ASIR/RsAIBH9GwFqIBH9GwJqIBH9GwNqIgo2AgAgCiAOIAogDkgbIQ4gCiANIAogDUobIQ0gAkEBaiICIAtHDQALDAILAn8gBSoCGLtEAAAAAABAj0CiIhCZRAAAAAAAAOBBYwRAIBCqDAELQYCAgIB4CyEKAn8gBSoCCLtEAAAAAABAj0CiIhCZRAAAAAAAAOBBYwRAIBCqDAELQYCAgIB4CyECAn8gBSoCKLtEAAAAAABAj0CiIhCZRAAAAAAAAOBBYwRAIBCqDAELQYCAgIB4CyEFQfj///8HIQ5BiICAgHghDSALIAxNDQEgAv0RIAr9HAEgBf0cAiESIAwhBQNAIAMgBUECdCICaiABIAAgAmooAgBBBHRq/QAAACAS/bUBIhH9GwAgEf0bAWogEf0bAmoiAjYCACACIA4gAiAOSBshDiACIA0gAiANShshDSAFQQFqIgUgC0cNAAsMAQsgDQRAQfj///8HIQ5BiICAgHghDSALIAxNDQEgDCEBA0AgAyABQQJ0IgVqAn8gAiAAIAVqKAIAQQJ0aioCALtEAAAAAAAAsECiIhCZRAAAAAAAAOBBYwRAIBCqDAELQYCAgIB4CyIKNgIAIAogDiAKIA5IGyEOIAogDSAKIA1KGyENIAFBAWoiASALRw0ACwwBCwJAIA9FBEAgCyAMSw0BQYiAgIB4IQ1B+P///wchDgwCC0H4////ByEOQYiAgIB4IQ0gCyAMTQ0BQX8hDyAMIQIDQCAPIAcgACACQQJ0IhRqKAIAQQJ0IhVqKAIAIgpHBEAgBf0JAgggCCAKQQZ0aiIP/QkCACAPKgIQ/SABIA8qAiD9IAIgDyoCMP0gA/3mASAF/QkCGCAP/QkCBCAPKgIU/SABIA8qAiT9IAIgDyoCNP0gA/3mAf3kASAF/QkCKCAP/QkCCCAPKgIY/SABIA8qAij9IAIgDyoCOP0gA/3mAf3kASAF/QkCOCAP/QkCDCAPKgIc/SABIA8qAiz9IAIgDyoCPP0gA/3mAf3kASERIAohDwsgAyAUagJ/IBEgASAVQQJ0IgpqKQIA/RL95gEiEv0fACAS/R8BkiARIBH9DQgJCgsMDQ4PAAAAAAAAAAAgASAKQQhyaikCAP0S/eYBIhL9HwCSIBL9HwGSu0QAAAAAAACwQKIiEJlEAAAAAAAA4EFjBEAgEKoMAQtBgICAgHgLIgo2AgAgCiAOIAogDkgbIQ4gCiANIAogDUobIQ0gAkEBaiICIAtHDQALDAELIAUqAighFiAFKgIYIRcgBSoCCCEYQfj///8HIQ5BiICAgHghDSAMIQUDQAJ/IBggASAAIAVBAnQiB2ooAgBBBHRqIgIqAgCUIBcgAioCBJSSIBYgAioCCJSSu0QAAAAAAACwQKIiEJlEAAAAAAAA4EFjBEAgEKoMAQtBgICAgHgLIQogAyAHaiAKNgIAIAogDiAKIA5IGyEOIAogDSAKIA1KGyENIAVBAWoiBSALRw0ACwsgCyAMSwRAIAlBAWuzIA2yIA6yk5UhFiAMIQ0DQAJ/IBYgAyANQQJ0aiIBKAIAIA5rspQiF4tDAAAAT10EQCAXqAwBC0GAgICAeAshCiABIAo2AgAgBCAKQQJ0aiIBIAEoAgBBAWo2AgAgDUEBaiINIAtHDQALCyAJQQJPBEAgBCgCACENQQEhDgNAIAQgDkECdGoiASABKAIAIA1qIg02AgAgDkEBaiIOIAlHDQALCyAMQQBKBEAgDCEOA0AgBiAOQQFrIgFBAnQiAmogACACaigCADYCACAOQQFKIQIgASEOIAINAAsLIAsgDEoEQCALIQ4DQCAGIAsgBCADIA5BAWsiDkECdCIBaigCAEECdGoiAigCACIFa0ECdGogACABaigCADYCACACIAVBAWs2AgAgDCAOSA0ACwsLBABBAAs=";

function sortWorker(self) {

    let wasmInstance;
    let wasmMemory;
    let useSharedMemory;
    let integerBasedSort;
    let dynamicMode;
    let splatCount;
    let indexesToSortOffset;
    let sortedIndexesOffset;
    let transformIndexesOffset;
    let transformsOffset;
    let precomputedDistancesOffset;
    let mappedDistancesOffset;
    let frequenciesOffset;
    let centersOffset;
    let modelViewProjOffset;
    let countsZero;
    let sortedIndexesOut;

    let Constants;

    function sort(splatSortCount, splatRenderCount, modelViewProj,
                  usePrecomputedDistances, copyIndexesToSort, copyPrecomputedDistances, copyTransforms) {
        const sortStartTime = performance.now();

        if (!useSharedMemory) {
            const indexesToSort = new Uint32Array(wasmMemory, indexesToSortOffset, copyIndexesToSort.byteLength / Constants.BytesPerInt);
            indexesToSort.set(copyIndexesToSort);
            const transforms = new Float32Array(wasmMemory, transformsOffset, copyTransforms.byteLength / Constants.BytesPerFloat);
            transforms.set(copyTransforms);
            if (usePrecomputedDistances) {
                let precomputedDistances;
                if (integerBasedSort) {
                    precomputedDistances = new Int32Array(wasmMemory, precomputedDistancesOffset,
                                                          copyPrecomputedDistances.byteLength / Constants.BytesPerInt);
                } else {
                    precomputedDistances = new Float32Array(wasmMemory, precomputedDistancesOffset,
                                                            copyPrecomputedDistances.byteLength / Constants.BytesPerFloat);
                }
                precomputedDistances.set(copyPrecomputedDistances);
            }
        }

        if (!countsZero) countsZero = new Uint32Array(Constants.DepthMapRange);
        new Float32Array(wasmMemory, modelViewProjOffset, 16).set(modelViewProj);
        new Uint32Array(wasmMemory, frequenciesOffset, Constants.DepthMapRange).set(countsZero);
        wasmInstance.exports.sortIndexes(indexesToSortOffset, centersOffset, precomputedDistancesOffset,
                                         mappedDistancesOffset, frequenciesOffset, modelViewProjOffset,
                                         sortedIndexesOffset, transformIndexesOffset, transformsOffset, Constants.DepthMapRange,
                                         splatSortCount, splatRenderCount, splatCount, usePrecomputedDistances, integerBasedSort,
                                         dynamicMode);

        const sortMessage = {
            'sortDone': true,
            'splatSortCount': splatSortCount,
            'splatRenderCount': splatRenderCount,
            'sortTime': 0
        };
        if (!useSharedMemory) {
            const sortedIndexes = new Uint32Array(wasmMemory, sortedIndexesOffset, splatRenderCount);
            if (!sortedIndexesOut || sortedIndexesOut.length < splatRenderCount) {
                sortedIndexesOut = new Uint32Array(splatRenderCount);
            }
            sortedIndexesOut.set(sortedIndexes);
            sortMessage.sortedIndexes = sortedIndexesOut;
        }
        const sortEndTime = performance.now();

        sortMessage.sortTime = sortEndTime - sortStartTime;

        self.postMessage(sortMessage);
    }

    self.onmessage = (e) => {
        if (e.data.centers) {
            centers = e.data.centers;
            transformIndexes = e.data.transformIndexes;
            if (integerBasedSort) {
                new Int32Array(wasmMemory, centersOffset + e.data.range.from * Constants.BytesPerInt * 4,
                               e.data.range.count * 4).set(new Int32Array(centers));
            } else {
                new Float32Array(wasmMemory, centersOffset + e.data.range.from * Constants.BytesPerFloat * 4,
                                 e.data.range.count * 4).set(new Float32Array(centers));
            }
            if (dynamicMode) {
                new Uint32Array(wasmMemory, transformIndexesOffset + e.data.range.from * 4,
                                e.data.range.count).set(new Uint32Array(transformIndexes));
            }
            self.postMessage({
                'centerDataSet': true,
            });
        } else if (e.data.sort) {
            const renderCount = e.data.sort.splatRenderCount || 0;
            const sortCount = e.data.sort.splatSortCount || 0;
            const usePrecomputedDistances = e.data.sort.usePrecomputedDistances;

            let copyIndexesToSort;
            let copyPrecomputedDistances;
            let copyTransforms;
            if (!useSharedMemory) {
                copyIndexesToSort = e.data.sort.indexesToSort;
                copyTransforms = e.data.sort.transforms;
                if (usePrecomputedDistances) copyPrecomputedDistances = e.data.sort.precomputedDistances;
            }
            sort(sortCount, renderCount, e.data.sort.modelViewProj, usePrecomputedDistances,
                 copyIndexesToSort, copyPrecomputedDistances, copyTransforms);
        } else if (e.data.init) {
            // Yep, this is super hacky and gross :(
            Constants = e.data.init.Constants;

            splatCount = e.data.init.splatCount;
            useSharedMemory = e.data.init.useSharedMemory;
            integerBasedSort = e.data.init.integerBasedSort;
            dynamicMode = e.data.init.dynamicMode;

            const CENTERS_BYTES_PER_ENTRY = integerBasedSort ? (Constants.BytesPerInt * 4) : (Constants.BytesPerFloat * 4);

            const sorterWasmBytes = new Uint8Array(e.data.init.sorterWasmBytes);

            const matrixSize = 16 * Constants.BytesPerFloat;
            const memoryRequiredForIndexesToSort = splatCount * Constants.BytesPerInt;
            const memoryRequiredForCenters = splatCount * CENTERS_BYTES_PER_ENTRY;
            const memoryRequiredForModelViewProjectionMatrix = matrixSize;
            const memoryRequiredForPrecomputedDistances = integerBasedSort ?
                                                          (splatCount * Constants.BytesPerInt) : (splatCount * Constants.BytesPerFloat);
            const memoryRequiredForMappedDistances = splatCount * Constants.BytesPerInt;
            const memoryRequiredForSortedIndexes = splatCount * Constants.BytesPerInt;
            const memoryRequiredForIntermediateSortBuffers = Constants.DepthMapRange * Constants.BytesPerInt * 2;
            const memoryRequiredforTransformIndexes = dynamicMode ? (splatCount * Constants.BytesPerInt) : 0;
            const memoryRequiredforTransforms = dynamicMode ? (Constants.MaxScenes * matrixSize) : 0;
            const extraMemory = Constants.MemoryPageSize * 32;

            const totalRequiredMemory = memoryRequiredForIndexesToSort +
                                        memoryRequiredForCenters +
                                        memoryRequiredForModelViewProjectionMatrix +
                                        memoryRequiredForPrecomputedDistances +
                                        memoryRequiredForMappedDistances +
                                        memoryRequiredForIntermediateSortBuffers +
                                        memoryRequiredForSortedIndexes +
                                        memoryRequiredforTransformIndexes +
                                        memoryRequiredforTransforms +
                                        extraMemory;
            const totalPagesRequired = Math.floor(totalRequiredMemory / Constants.MemoryPageSize ) + 1;
            const sorterWasmImport = {
                module: {},
                env: {
                    memory: new WebAssembly.Memory({
                        initial: totalPagesRequired * 2,
                        maximum: totalPagesRequired * 4,
                        shared: true,
                    }),
                }
            };
            WebAssembly.compile(sorterWasmBytes)
            .then((wasmModule) => {
                return WebAssembly.instantiate(wasmModule, sorterWasmImport);
            })
            .then((instance) => {
                wasmInstance = instance;
                indexesToSortOffset = 0;
                centersOffset = indexesToSortOffset + memoryRequiredForIndexesToSort;
                modelViewProjOffset = centersOffset + memoryRequiredForCenters;
                precomputedDistancesOffset = modelViewProjOffset + memoryRequiredForModelViewProjectionMatrix;
                mappedDistancesOffset = precomputedDistancesOffset + memoryRequiredForPrecomputedDistances;
                frequenciesOffset = mappedDistancesOffset + memoryRequiredForMappedDistances;
                sortedIndexesOffset = frequenciesOffset + memoryRequiredForIntermediateSortBuffers;
                transformIndexesOffset = sortedIndexesOffset + memoryRequiredForSortedIndexes;
                transformsOffset = transformIndexesOffset + memoryRequiredforTransformIndexes;
                wasmMemory = sorterWasmImport.env.memory.buffer;
                if (useSharedMemory) {
                    self.postMessage({
                        'sortSetupPhase1Complete': true,
                        'indexesToSortBuffer': wasmMemory,
                        'indexesToSortOffset': indexesToSortOffset,
                        'sortedIndexesBuffer': wasmMemory,
                        'sortedIndexesOffset': sortedIndexesOffset,
                        'precomputedDistancesBuffer': wasmMemory,
                        'precomputedDistancesOffset': precomputedDistancesOffset,
                        'transformsBuffer': wasmMemory,
                        'transformsOffset': transformsOffset
                    });
                } else {
                    self.postMessage({
                        'sortSetupPhase1Complete': true
                    });
                }
            });
        }
    };
}

function createSortWorker(splatCount, useSharedMemory, integerBasedSort, dynamicMode) {
    const worker = new Worker(
        URL.createObjectURL(
            new Blob(['(', sortWorker.toString(), ')(self)'], {
                type: 'application/javascript',
            }),
        ),
    );

    const sorterWasmBinaryString = atob(SorterWasm);
    const sorterWasmBytes = new Uint8Array(sorterWasmBinaryString.length);
    for (let i = 0; i < sorterWasmBinaryString.length; i++) {
        sorterWasmBytes[i] = sorterWasmBinaryString.charCodeAt(i);
    }

    worker.postMessage({
        'init': {
            'sorterWasmBytes': sorterWasmBytes.buffer,
            'splatCount': splatCount,
            'useSharedMemory': useSharedMemory,
            'integerBasedSort': integerBasedSort,
            'dynamicMode': dynamicMode,
            // Super hacky
            'Constants': {
                'BytesPerFloat': Constants.BytesPerFloat,
                'BytesPerInt': Constants.BytesPerInt,
                'DepthMapRange': Constants.DepthMapRange,
                'MemoryPageSize': Constants.MemoryPageSize,
                'MaxScenes': Constants.MaxScenes
            }
        }
    });
    return worker;
}

const WebXRMode = {
    None: 0,
    VR: 1,
    AR: 2
};

/*
Copyright © 2010-2024 three.js authors & Mark Kellogg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
*/

class VRButton {

    static createButton( renderer ) {

        const button = document.createElement( 'button' );

        function showEnterVR( /* device */ ) {

            let currentSession = null;

            async function onSessionStarted( session ) {

                session.addEventListener( 'end', onSessionEnded );

                await renderer.xr.setSession( session );
                button.textContent = 'EXIT VR';

                currentSession = session;

            }

            function onSessionEnded( /* event */ ) {

                currentSession.removeEventListener( 'end', onSessionEnded );

                button.textContent = 'ENTER VR';

                currentSession = null;

            }

            //

            button.style.display = '';

            button.style.cursor = 'pointer';
            button.style.left = 'calc(50% - 50px)';
            button.style.width = '100px';

            button.textContent = 'ENTER VR';

            // WebXR's requestReferenceSpace only works if the corresponding feature
            // was requested at session creation time. For simplicity, just ask for
            // the interesting ones as optional features, but be aware that the
            // requestReferenceSpace call will fail if it turns out to be unavailable.
            // ('local' is always available for immersive sessions and doesn't need to
            // be requested separately.)

            const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] };

            button.onmouseenter = function() {

                button.style.opacity = '1.0';

            };

            button.onmouseleave = function() {

                button.style.opacity = '0.5';

            };

            button.onclick = function() {

                if ( currentSession === null ) {

                    navigator.xr.requestSession( 'immersive-vr', sessionInit ).then( onSessionStarted );

                } else {

                    currentSession.end();

                    if ( navigator.xr.offerSession !== undefined ) {

                        navigator.xr.offerSession( 'immersive-vr', sessionInit )
                            .then( onSessionStarted )
                            .catch( ( err ) => {

                                console.warn( err );

                            } );

                    }

                }

            };

            if ( navigator.xr.offerSession !== undefined ) {

                navigator.xr.offerSession( 'immersive-vr', sessionInit )
                    .then( onSessionStarted )
                    .catch( ( err ) => {

                        console.warn( err );

                    } );

            }

        }

        function disableButton() {

            button.style.display = '';

            button.style.cursor = 'auto';
            button.style.left = 'calc(50% - 75px)';
            button.style.width = '150px';

            button.onmouseenter = null;
            button.onmouseleave = null;

            button.onclick = null;

        }

        function showWebXRNotFound() {

            disableButton();

            button.textContent = 'VR NOT SUPPORTED';

        }

        function showVRNotAllowed( exception ) {

            disableButton();

            console.warn( 'Exception when trying to call xr.isSessionSupported', exception );

            button.textContent = 'VR NOT ALLOWED';

        }

        function stylizeElement( element ) {

            element.style.position = 'absolute';
            element.style.bottom = '20px';
            element.style.padding = '12px 6px';
            element.style.border = '1px solid #fff';
            element.style.borderRadius = '4px';
            element.style.background = 'rgba(0,0,0,0.1)';
            element.style.color = '#fff';
            element.style.font = 'normal 13px sans-serif';
            element.style.textAlign = 'center';
            element.style.opacity = '0.5';
            element.style.outline = 'none';
            element.style.zIndex = '999';

        }

        if ( 'xr' in navigator ) {

            button.id = 'VRButton';
            button.style.display = 'none';

            stylizeElement( button );

            navigator.xr.isSessionSupported( 'immersive-vr' ).then( function( supported ) {

                supported ? showEnterVR() : showWebXRNotFound();

                if ( supported && VRButton.xrSessionIsGranted ) {

                    button.click();

                }

            } ).catch( showVRNotAllowed );

            return button;

        } else {

            const message = document.createElement( 'a' );

            if ( window.isSecureContext === false ) {

                message.href = document.location.href.replace( /^http:/, 'https:' );
                message.innerHTML = 'WEBXR NEEDS HTTPS'; // TODO Improve message

            } else {

                message.href = 'https://immersiveweb.dev/';
                message.innerHTML = 'WEBXR NOT AVAILABLE';

            }

            message.style.left = 'calc(50% - 90px)';
            message.style.width = '180px';
            message.style.textDecoration = 'none';

            stylizeElement( message );

            return message;

        }

    }

    static registerSessionGrantedListener() {

        if ( typeof navigator !== 'undefined' && 'xr' in navigator ) {

            // WebXRViewer (based on Firefox) has a bug where addEventListener
            // throws a silent exception and aborts execution entirely.
            if ( /WebXRViewer\//i.test( navigator.userAgent ) ) return;

            navigator.xr.addEventListener( 'sessiongranted', () => {

                VRButton.xrSessionIsGranted = true;

            } );

        }

    }

}

VRButton.xrSessionIsGranted = false;
VRButton.registerSessionGrantedListener();

/*
Copyright © 2010-2024 three.js authors & Mark Kellogg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
*/

class ARButton {

    static createButton( renderer, sessionInit = {} ) {

        const button = document.createElement( 'button' );

        function showStartAR( /* device */ ) {

            if ( sessionInit.domOverlay === undefined ) {

                const overlay = document.createElement( 'div' );
                overlay.style.display = 'none';
                document.body.appendChild( overlay );

                const svg = document.createElementNS( 'http://www.w3.org/2000/svg', 'svg' );
                svg.setAttribute( 'width', 38 );
                svg.setAttribute( 'height', 38 );
                svg.style.position = 'absolute';
                svg.style.right = '20px';
                svg.style.top = '20px';
                svg.addEventListener( 'click', function() {

                    currentSession.end();

                } );
                overlay.appendChild( svg );

                const path = document.createElementNS( 'http://www.w3.org/2000/svg', 'path' );
                path.setAttribute( 'd', 'M 12,12 L 28,28 M 28,12 12,28' );
                path.setAttribute( 'stroke', '#fff' );
                path.setAttribute( 'stroke-width', 2 );
                svg.appendChild( path );

                if ( sessionInit.optionalFeatures === undefined ) {

                    sessionInit.optionalFeatures = [];

                }

                sessionInit.optionalFeatures.push( 'dom-overlay' );
                sessionInit.domOverlay = { root: overlay };

            }

            //

            let currentSession = null;

            async function onSessionStarted( session ) {

                session.addEventListener( 'end', onSessionEnded );

                renderer.xr.setReferenceSpaceType( 'local' );

                await renderer.xr.setSession( session );

                button.textContent = 'STOP AR';
                sessionInit.domOverlay.root.style.display = '';

                currentSession = session;

            }

            function onSessionEnded( /* event */ ) {

                currentSession.removeEventListener( 'end', onSessionEnded );

                button.textContent = 'START AR';
                sessionInit.domOverlay.root.style.display = 'none';

                currentSession = null;

            }

            //

            button.style.display = '';

            button.style.cursor = 'pointer';
            button.style.left = 'calc(50% - 50px)';
            button.style.width = '100px';

            button.textContent = 'START AR';

            button.onmouseenter = function() {

                button.style.opacity = '1.0';

            };

            button.onmouseleave = function() {

                button.style.opacity = '0.5';

            };

            button.onclick = function() {

                if ( currentSession === null ) {

                    navigator.xr.requestSession( 'immersive-ar', sessionInit ).then( onSessionStarted );

                } else {

                    currentSession.end();

                    if ( navigator.xr.offerSession !== undefined ) {

                        navigator.xr.offerSession( 'immersive-ar', sessionInit )
                            .then( onSessionStarted )
                            .catch( ( err ) => {

                                console.warn( err );

                            } );

                    }

                }

            };

            if ( navigator.xr.offerSession !== undefined ) {

                navigator.xr.offerSession( 'immersive-ar', sessionInit )
                    .then( onSessionStarted )
                    .catch( ( err ) => {

                        console.warn( err );

                    } );

            }

        }

        function disableButton() {

            button.style.display = '';

            button.style.cursor = 'auto';
            button.style.left = 'calc(50% - 75px)';
            button.style.width = '150px';

            button.onmouseenter = null;
            button.onmouseleave = null;

            button.onclick = null;

        }

        function showARNotSupported() {

            disableButton();

            button.textContent = 'AR NOT SUPPORTED';

        }

        function showARNotAllowed( exception ) {

            disableButton();

            console.warn( 'Exception when trying to call xr.isSessionSupported', exception );

            button.textContent = 'AR NOT ALLOWED';

        }

        function stylizeElement( element ) {

            element.style.position = 'absolute';
            element.style.bottom = '20px';
            element.style.padding = '12px 6px';
            element.style.border = '1px solid #fff';
            element.style.borderRadius = '4px';
            element.style.background = 'rgba(0,0,0,0.1)';
            element.style.color = '#fff';
            element.style.font = 'normal 13px sans-serif';
            element.style.textAlign = 'center';
            element.style.opacity = '0.5';
            element.style.outline = 'none';
            element.style.zIndex = '999';

        }

        if ( 'xr' in navigator ) {

            button.id = 'ARButton';
            button.style.display = 'none';

            stylizeElement( button );

            navigator.xr.isSessionSupported( 'immersive-ar' ).then( function( supported ) {

                supported ? showStartAR() : showARNotSupported();

            } ).catch( showARNotAllowed );

            return button;

        } else {

            const message = document.createElement( 'a' );

            if ( window.isSecureContext === false ) {

                message.href = document.location.href.replace( /^http:/, 'https:' );
                message.innerHTML = 'WEBXR NEEDS HTTPS'; // TODO Improve message

            } else {

                message.href = 'https://immersiveweb.dev/';
                message.innerHTML = 'WEBXR NOT AVAILABLE';

            }

            message.style.left = 'calc(50% - 90px)';
            message.style.width = '180px';
            message.style.textDecoration = 'none';

            stylizeElement( message );

            return message;

        }

    }

}

const RenderMode = {
    Always: 0,
    OnChange: 1,
    Never: 2
};

const THREE_CAMERA_FOV = 50;
const MINIMUM_DISTANCE_TO_NEW_FOCAL_POINT = .75;
const MIN_SPLAT_COUNT_TO_SHOW_SPLAT_TREE_LOADING_SPINNER = 1500000;
const FOCUS_MARKER_FADE_IN_SPEED = 10.0;
const FOCUS_MARKER_FADE_OUT_SPEED = 2.5;
const CONSECUTIVE_RENDERED_FRAMES_FOR_FPS_CALCULATION = 60;

/**
 * Viewer: Manages the rendering of splat scenes. Manages an instance of SplatMesh as well as a web worker
 * that performs the sort for its splats.
 */
class Viewer {

    constructor(options = {}) {

        // The natural 'up' vector for viewing the scene (only has an effect when used with orbit controls and
        // when the viewer uses its own camera).
        if (!options.cameraUp) options.cameraUp = [0, 1, 0];
        this.cameraUp = new THREE.Vector3().fromArray(options.cameraUp);

        // The camera's initial position (only used when the viewer uses its own camera).
        if (!options.initialCameraPosition) options.initialCameraPosition = [0, 10, 15];
        this.initialCameraPosition = new THREE.Vector3().fromArray(options.initialCameraPosition);

        // The initial focal point of the camera and center of the camera's orbit (only used when the viewer uses its own camera).
        if (!options.initialCameraLookAt) options.initialCameraLookAt = [0, 0, 0];
        this.initialCameraLookAt = new THREE.Vector3().fromArray(options.initialCameraLookAt);

        // 'dropInMode' is a flag that is used internally to support the usage of the viewer as a Three.js scene object
        this.dropInMode = options.dropInMode || false;

        // If 'selfDrivenMode' is true, the viewer manages its own update/animation loop via requestAnimationFrame()
        if (options.selfDrivenMode === undefined || options.selfDrivenMode === null) options.selfDrivenMode = true;
        this.selfDrivenMode = options.selfDrivenMode && !this.dropInMode;
        this.selfDrivenUpdateFunc = this.selfDrivenUpdate.bind(this);

        // If 'useBuiltInControls' is true, the viewer will create its own instance of OrbitControls and attach to the camera
        if (options.useBuiltInControls === undefined) options.useBuiltInControls = true;
        this.useBuiltInControls = options.useBuiltInControls;

        // parent element of the Three.js renderer canvas
        this.rootElement = options.rootElement;

        // Tells the viewer to pretend the device pixel ratio is 1, which can boost performance on devices where it is larger,
        // at a small cost to visual quality
        this.ignoreDevicePixelRatio = options.ignoreDevicePixelRatio || false;
        this.devicePixelRatio = this.ignoreDevicePixelRatio ? 1 : window.devicePixelRatio;

        // Tells the viewer to use 16-bit floating point values when storing splat covariance data in textures, instead of 32-bit
        this.halfPrecisionCovariancesOnGPU = options.halfPrecisionCovariancesOnGPU || false;

        // If 'threeScene' is valid, it will be rendered by the viewer along with the splat mesh
        this.threeScene = options.threeScene;
        // Allows for usage of an external Three.js renderer
        this.renderer = options.renderer;
        // Allows for usage of an external Three.js camera
        this.camera = options.camera;

        // If 'gpuAcceleratedSort' is true, a partially GPU-accelerated approach to sorting splats will be used.
        // Currently this means pre-computing splat distances from the camera on the GPU
        this.gpuAcceleratedSort = options.gpuAcceleratedSort || false;

        // if 'integerBasedSort' is true, the integer version of splat centers as well as other values used to calculate
        // splat distances are used instead of the float version. This speeds up computation, but introduces the possibility of
        // overflow in larger scenes.
        if (options.integerBasedSort === undefined || options.integerBasedSort === null) {
            options.integerBasedSort = true;
        }
        this.integerBasedSort = options.integerBasedSort;

        // If 'sharedMemoryForWorkers' is true, a SharedArrayBuffer will be used to communicate with web workers. This method
        // is faster than copying memory to or from web workers, but comes with security implications as outlined here:
        // https://web.dev/articles/cross-origin-isolation-guide
        // If enabled, it requires specific CORS headers to be present in the response from the server that is sent when
        // loading the application. More information is available in the README.
        if (options.sharedMemoryForWorkers === undefined || options.sharedMemoryForWorkers === null) options.sharedMemoryForWorkers = true;
        this.sharedMemoryForWorkers = options.sharedMemoryForWorkers;

        // if 'dynamicScene' is true, it tells the viewer to assume scene elements are not stationary or that the number of splats in the
        // scene may change. This prevents optimizations that depend on a static scene from being made. Additionally, if 'dynamicScene' is
        // true it tells the splat mesh to not apply scene tranforms to splat data that is returned by functions like
        // SplatMesh.getSplatCenter() by default.
        this.dynamicScene = !!options.dynamicScene;

        // When true, will perform additional steps during rendering to address artifacts caused by the rendering of gaussians at a
        // substantially different resolution than that at which they were rendered during training. This will only work correctly
        // for models that were trained using a process that utilizes this compensation calculation. For more details:
        // https://github.com/nerfstudio-project/gsplat/pull/117
        // https://github.com/graphdeco-inria/gaussian-splatting/issues/294#issuecomment-1772688093
        this.antialiased = options.antialiased || false;

        this.webXRMode = options.webXRMode || WebXRMode.None;
        if (this.webXRMode !== WebXRMode.None) {
            this.gpuAcceleratedSort = false;
        }
        this.webXRActive = false;

        // if 'renderMode' is RenderMode.Always, then the viewer will rrender the scene on every update. If it is RenderMode.OnChange,
        // it will only render when something in the scene has changed.
        this.renderMode = options.renderMode || RenderMode.Always;

        // SceneRevealMode.Default results in a nice, slow fade-in effect for progressively loaded scenes,
        // and a fast fade-in for non progressively loaded scenes.
        // SceneRevealMode.Gradual will force a slow fade-in for all scenes.
        // SceneRevealMode.Instant will force all loaded scene data to be immediately visible.
        this.sceneRevealMode = options.sceneRevealMode || SceneRevealMode.Default;

        // Hacky, experimental, non-scientific parameter for tweaking focal length related calculations. For scenes with very
        // small gaussians, small details, and small dimensions -- increasing this value can help improve visual quality.
        this.focalAdjustment = options.focalAdjustment || 1.0;

        // Specify the maximum screen-space splat size, can help deal with large splats that get too unwieldy
        this.maxScreenSpaceSplatSize = options.maxScreenSpaceSplatSize || 2048;

        // The verbosity of console logging
        this.logLevel = options.logLevel || LogLevel.None;

        // Degree of spherical harmonics to utilize in rendering splats (assuming the data is present in the splat scene).
        // Valid values are 0 - 3. Default value is 0.
        this.sphericalHarmonicsDegree = options.sphericalHarmonicsDegree || 0;

        this.createSplatMesh();

        this.controls = null;
        this.perspectiveControls = null;
        this.orthographicControls = null;

        this.orthographicCamera = null;
        this.perspectiveCamera = null;

        this.showMeshCursor = false;
        this.showControlPlane = false;
        this.showInfo = false;

        this.sceneHelper = null;

        this.sortWorker = null;
        this.sortRunning = false;
        this.splatRenderCount = 0;
        this.sortWorkerIndexesToSort = null;
        this.sortWorkerSortedIndexes = null;
        this.sortWorkerPrecomputedDistances = null;
        this.sortWorkerTransforms = null;
        this.runAfterFirstSort = [];

        this.selfDrivenModeRunning = false;
        this.splatRenderReady = false;

        this.raycaster = new Raycaster();

        this.infoPanel = null;

        this.startInOrthographicMode = false;

        this.currentFPS = 0;
        this.lastSortTime = 0;
        this.consecutiveRenderFrames = 0;

        this.previousCameraTarget = new THREE.Vector3();
        this.nextCameraTarget = new THREE.Vector3();

        this.mousePosition = new THREE.Vector2();
        this.mouseDownPosition = new THREE.Vector2();
        this.mouseDownTime = null;

        this.resizeObserver = null;
        this.mouseMoveListener = null;
        this.mouseDownListener = null;
        this.mouseUpListener = null;
        this.keyDownListener = null;

        this.sortPromise = null;
        this.sortPromiseResolver = null;
        this.splatSceneDownloadPromises = {};
        this.splatSceneDownloadAndBuildPromise = null;
        this.splatSceneRemovalPromise = null;

        this.loadingSpinner = new LoadingSpinner(null, this.rootElement || document.body);
        this.loadingSpinner.hide();
        this.loadingProgressBar = new LoadingProgressBar(this.rootElement || document.body);
        this.loadingProgressBar.hide();
        this.infoPanel = new InfoPanel(this.rootElement || document.body);
        this.infoPanel.hide();

        this.usingExternalCamera = (this.dropInMode || this.camera) ? true : false;
        this.usingExternalRenderer = (this.dropInMode || this.renderer) ? true : false;

        this.initialized = false;
        this.disposing = false;
        this.disposed = false;
        if (!this.dropInMode) this.init();
    }

    createSplatMesh() {
        this.splatMesh = new SplatMesh(this.dynamicScene, this.halfPrecisionCovariancesOnGPU, this.devicePixelRatio,
                                       this.gpuAcceleratedSort, this.integerBasedSort, this.antialiased,
                                       this.maxScreenSpaceSplatSize, this.logLevel, this.sphericalHarmonicsDegree);
        this.splatMesh.frustumCulled = false;
    }

    init() {

        if (this.initialized) return;

        if (!this.rootElement) {
            if (!this.usingExternalRenderer) {
                this.rootElement = document.createElement('div');
                this.rootElement.style.width = '100%';
                this.rootElement.style.height = '100%';
                this.rootElement.style.position = 'absolute';
                document.body.appendChild(this.rootElement);
            } else {
                this.rootElement = this.renderer.domElement.parentElement || document.body;
            }
        }

        this.setupCamera();
        this.setupRenderer();
        this.setupWebXR();
        this.setupControls();
        this.setupEventHandlers();

        this.threeScene = this.threeScene || new THREE.Scene();
        this.sceneHelper = new SceneHelper(this.threeScene);
        this.sceneHelper.setupMeshCursor();
        this.sceneHelper.setupFocusMarker();
        this.sceneHelper.setupControlPlane();

        this.loadingProgressBar.setContainer(this.rootElement);
        this.loadingSpinner.setContainer(this.rootElement);
        this.infoPanel.setContainer(this.rootElement);

        this.initialized = true;
    }

    setupCamera() {
        if (!this.usingExternalCamera) {
            const renderDimensions = new THREE.Vector2();
            this.getRenderDimensions(renderDimensions);

            this.perspectiveCamera = new THREE.PerspectiveCamera(THREE_CAMERA_FOV, renderDimensions.x / renderDimensions.y, 0.1, 1000);
            this.orthographicCamera = new THREE.OrthographicCamera(renderDimensions.x / -2, renderDimensions.x / 2,
                                                                   renderDimensions.y / 2, renderDimensions.y / -2, 0.1, 1000 );
            this.camera = this.startInOrthographicMode ? this.orthographicCamera : this.perspectiveCamera;
            this.camera.position.copy(this.initialCameraPosition);
            this.camera.up.copy(this.cameraUp).normalize();
            this.camera.lookAt(this.initialCameraLookAt);
        }
    }

    setupRenderer() {
        if (!this.usingExternalRenderer) {
            const renderDimensions = new THREE.Vector2();
            this.getRenderDimensions(renderDimensions);

            this.renderer = new THREE.WebGLRenderer({
                antialias: false,
                precision: 'highp'
            });
            this.renderer.setPixelRatio(this.devicePixelRatio);
            this.renderer.autoClear = true;
            this.renderer.setClearColor(new THREE.Color( 0x000000 ), 0.0);
            this.renderer.setSize(renderDimensions.x, renderDimensions.y);

            this.resizeObserver = new ResizeObserver(() => {
                this.getRenderDimensions(renderDimensions);
                this.renderer.setSize(renderDimensions.x, renderDimensions.y);
                this.forceRenderNextFrame();
            });
            this.resizeObserver.observe(this.rootElement);
            this.rootElement.appendChild(this.renderer.domElement);
        }

    }

    setupWebXR() {
        if (this.webXRMode) {
            if (this.webXRMode === WebXRMode.VR) {
                this.rootElement.appendChild(VRButton.createButton(this.renderer));
            } else if (this.webXRMode === WebXRMode.AR) {
                this.rootElement.appendChild(ARButton.createButton(this.renderer));
            }
            this.renderer.xr.addEventListener('sessionstart', (e) => {
                this.webXRActive = true;
            });
            this.renderer.xr.addEventListener('sessionend', (e) => {
                this.webXRActive = false;
            });
            this.renderer.xr.enabled = true;
            this.camera.position.copy(this.initialCameraPosition);
            this.camera.up.copy(this.cameraUp).normalize();
            this.camera.lookAt(this.initialCameraLookAt);
        }
    }

    setupControls() {
        if (this.useBuiltInControls && this.webXRMode === WebXRMode.None) {
            if (!this.usingExternalCamera) {
                this.perspectiveControls = new OrbitControls(this.perspectiveCamera, this.renderer.domElement);
                this.orthographicControls = new OrbitControls(this.orthographicCamera, this.renderer.domElement);
            } else {
                if (this.camera.isOrthographicCamera) {
                    this.orthographicControls = new OrbitControls(this.camera, this.renderer.domElement);
                } else {
                    this.perspectiveControls = new OrbitControls(this.camera, this.renderer.domElement);
                }
            }
            for (let controls of [this.perspectiveControls, this.orthographicControls]) {
                if (controls) {
                    controls.listenToKeyEvents(window);
                    controls.rotateSpeed = 0.5;
                    controls.maxPolarAngle = Math.PI * .75;
                    controls.minPolarAngle = 0.1;
                    controls.enableDamping = true;
                    controls.dampingFactor = 0.05;
                    controls.target.copy(this.initialCameraLookAt);
                }
            }
            this.controls = this.camera.isOrthographicCamera ? this.orthographicControls : this.perspectiveControls;
        }
    }

    setupEventHandlers() {
        if (this.useBuiltInControls && this.webXRMode === WebXRMode.None) {
            this.mouseMoveListener = this.onMouseMove.bind(this);
            this.renderer.domElement.addEventListener('pointermove', this.mouseMoveListener, false);
            this.mouseDownListener = this.onMouseDown.bind(this);
            this.renderer.domElement.addEventListener('pointerdown', this.mouseDownListener, false);
            this.mouseUpListener = this.onMouseUp.bind(this);
            this.renderer.domElement.addEventListener('pointerup', this.mouseUpListener, false);
            this.keyDownListener = this.onKeyDown.bind(this);
            window.addEventListener('keydown', this.keyDownListener, false);
        }
    }

    removeEventHandlers() {
        if (this.useBuiltInControls) {
            this.renderer.domElement.removeEventListener('pointermove', this.mouseMoveListener);
            this.mouseMoveListener = null;
            this.renderer.domElement.removeEventListener('pointerdown', this.mouseDownListener);
            this.mouseDownListener = null;
            this.renderer.domElement.removeEventListener('pointerup', this.mouseUpListener);
            this.mouseUpListener = null;
            window.removeEventListener('keydown', this.keyDownListener);
            this.keyDownListener = null;
        }
    }

    setRenderMode(renderMode) {
        this.renderMode = renderMode;
    }

    onKeyDown = function() {

        const forward = new THREE.Vector3();
        const tempMatrixLeft = new THREE.Matrix4();
        const tempMatrixRight = new THREE.Matrix4();

        return function(e) {
            forward.set(0, 0, -1);
            forward.transformDirection(this.camera.matrixWorld);
            tempMatrixLeft.makeRotationAxis(forward, Math.PI / 128);
            tempMatrixRight.makeRotationAxis(forward, -Math.PI / 128);
            switch (e.code) {
                case 'KeyG':
                    this.focalAdjustment += 0.02;
                    this.forceRenderNextFrame();
                break;
                case 'KeyF':
                    this.focalAdjustment -= 0.02;
                    this.forceRenderNextFrame();
                break;
                case 'ArrowLeft':
                    this.camera.up.transformDirection(tempMatrixLeft);
                break;
                case 'ArrowRight':
                    this.camera.up.transformDirection(tempMatrixRight);
                break;
                case 'KeyC':
                    this.showMeshCursor = !this.showMeshCursor;
                break;
                case 'KeyU':
                    this.showControlPlane = !this.showControlPlane;
                break;
                case 'KeyI':
                    this.showInfo = !this.showInfo;
                    if (this.showInfo) {
                        this.infoPanel.show();
                    } else {
                        this.infoPanel.hide();
                    }
                break;
                case 'KeyO':
                    if (!this.usingExternalCamera) {
                        this.setOrthographicMode(!this.camera.isOrthographicCamera);
                    }
                break;
                case 'KeyP':
                    if (!this.usingExternalCamera) {
                        this.splatMesh.setPointCloudModeEnabled(!this.splatMesh.getPointCloudModeEnabled());
                    }
                break;
                case 'Equal':
                    if (!this.usingExternalCamera) {
                        this.splatMesh.setSplatScale(this.splatMesh.getSplatScale() + 0.05);
                    }
                break;
                case 'Minus':
                    if (!this.usingExternalCamera) {
                        this.splatMesh.setSplatScale(Math.max(this.splatMesh.getSplatScale() - 0.05, 0.0));
                    }
                break;
            }
        };

    }();

    onMouseMove(mouse) {
        this.mousePosition.set(mouse.offsetX, mouse.offsetY);
    }

    onMouseDown() {
        this.mouseDownPosition.copy(this.mousePosition);
        this.mouseDownTime = getCurrentTime();
    }

    onMouseUp = function() {

        const clickOffset = new THREE.Vector2();

        return function(mouse) {
            clickOffset.copy(this.mousePosition).sub(this.mouseDownPosition);
            const mouseUpTime = getCurrentTime();
            const wasClick = mouseUpTime - this.mouseDownTime < 0.5 && clickOffset.length() < 2;
            if (wasClick) {
                this.onMouseClick(mouse);
            }
        };

    }();

    onMouseClick(mouse) {
        this.mousePosition.set(mouse.offsetX, mouse.offsetY);
        this.checkForFocalPointChange();
    }

    checkForFocalPointChange = function() {

        const renderDimensions = new THREE.Vector2();
        const toNewFocalPoint = new THREE.Vector3();
        const outHits = [];

        return function() {
            if (!this.transitioningCameraTarget) {
                this.getRenderDimensions(renderDimensions);
                outHits.length = 0;
                this.raycaster.setFromCameraAndScreenPosition(this.camera, this.mousePosition, renderDimensions);
                this.raycaster.intersectSplatMesh(this.splatMesh, outHits);
                if (outHits.length > 0) {
                    const hit = outHits[0];
                    const intersectionPoint = hit.origin;
                    toNewFocalPoint.copy(intersectionPoint).sub(this.camera.position);
                    if (toNewFocalPoint.length() > MINIMUM_DISTANCE_TO_NEW_FOCAL_POINT) {
                        this.previousCameraTarget.copy(this.controls.target);
                        this.nextCameraTarget.copy(intersectionPoint);
                        this.transitioningCameraTarget = true;
                        this.transitioningCameraTargetStartTime = getCurrentTime();
                    }
                }
            }
        };

    }();

    getRenderDimensions(outDimensions) {
        if (this.rootElement) {
            outDimensions.x = this.rootElement.offsetWidth;
            outDimensions.y = this.rootElement.offsetHeight;
        } else {
            this.renderer.getSize(outDimensions);
        }
    }

    setOrthographicMode(orthographicMode) {
        if (orthographicMode === this.camera.isOrthographicCamera) return;
        const fromCamera = this.camera;
        const toCamera = orthographicMode ? this.orthographicCamera : this.perspectiveCamera;
        toCamera.position.copy(fromCamera.position);
        toCamera.up.copy(fromCamera.up);
        toCamera.rotation.copy(fromCamera.rotation);
        toCamera.quaternion.copy(fromCamera.quaternion);
        toCamera.matrix.copy(fromCamera.matrix);
        this.camera = toCamera;

        if (this.controls) {

            const resetControls = (controls) => {
                controls.saveState();
                controls.reset();
            };

            const fromControls = this.controls;
            const toControls = orthographicMode ? this.orthographicControls : this.perspectiveControls;

            resetControls(toControls);
            resetControls(fromControls);

            toControls.target.copy(fromControls.target);
            if (orthographicMode) {
                Viewer.setCameraZoomFromPosition(toCamera, fromCamera, fromControls);
            } else {
                Viewer.setCameraPositionFromZoom(toCamera, fromCamera, toControls);
            }
            this.controls = toControls;
            this.camera.lookAt(this.controls.target);
        }
    }

    static setCameraPositionFromZoom = function() {

        const tempVector = new THREE.Vector3();

        return function(positionCamera, zoomedCamera, controls) {
            const toLookAtDistance = 1 / (zoomedCamera.zoom * 0.001);
            tempVector.copy(controls.target).sub(positionCamera.position).normalize().multiplyScalar(toLookAtDistance).negate();
            positionCamera.position.copy(controls.target).add(tempVector);
        };

    }();


    static setCameraZoomFromPosition = function() {

        const tempVector = new THREE.Vector3();

        return function(zoomCamera, positionZamera, controls) {
            const toLookAtDistance = tempVector.copy(controls.target).sub(positionZamera.position).length();
            zoomCamera.zoom = 1 / (toLookAtDistance * .001);
        };

    }();

    updateSplatMesh = function() {

        const renderDimensions = new THREE.Vector2();

        return function() {
            if (!this.splatMesh) return;
            const splatCount = this.splatMesh.getSplatCount();
            if (splatCount > 0) {
                this.splatMesh.updateTransforms();
                this.getRenderDimensions(renderDimensions);
                const focalLengthX = this.camera.projectionMatrix.elements[0] * 0.5 *
                                     this.devicePixelRatio * renderDimensions.x;
                const focalLengthY = this.camera.projectionMatrix.elements[5] * 0.5 *
                                     this.devicePixelRatio * renderDimensions.y;

                const focalMultiplier = this.camera.isOrthographicCamera ? (1.0 / this.devicePixelRatio) : 1.0;
                const focalAdjustment = this.focalAdjustment * focalMultiplier;
                const inverseFocalAdjustment = 1.0 / focalAdjustment;

                this.adjustForWebXRStereo(renderDimensions);
                this.splatMesh.updateUniforms(renderDimensions, focalLengthX * focalAdjustment, focalLengthY * focalAdjustment,
                                              this.camera.isOrthographicCamera, this.camera.zoom || 1.0, inverseFocalAdjustment);
            }
        };

    }();

    adjustForWebXRStereo(renderDimensions) {
        // TODO: Figure out a less hacky way to determine if stereo rendering is active
        if (this.camera && this.webXRActive) {
            const xrCamera = this.renderer.xr.getCamera();
            const xrCameraProj00 = xrCamera.projectionMatrix.elements[0];
            const cameraProj00 = this.camera.projectionMatrix.elements[0];
            renderDimensions.x *= (cameraProj00 / xrCameraProj00);
        }
    }

    isLoadingOrUnloading() {
        return Object.keys(this.splatSceneDownloadPromises).length > 0 || this.splatSceneDownloadAndBuildPromise !== null ||
                           this.splatSceneRemovalPromise !== null;
    }

    isDisposingOrDisposed() {
        return this.disposing || this.disposed;
    }

    addSplatSceneDownloadPromise(promise) {
        this.splatSceneDownloadPromises[promise.id] = promise;
    }

    removeSplatSceneDownloadPromise(promise) {
        delete this.splatSceneDownloadPromises[promise.id];
    }

    setSplatSceneDownloadAndBuildPromise(promise) {
        this.splatSceneDownloadAndBuildPromise = promise;
    }

    clearSplatSceneDownloadAndBuildPromise() {
        this.splatSceneDownloadAndBuildPromise = null;
    }

    /**
     * Add a splat scene to the viewer and display any loading UI if appropriate.
     * @param {string} path Path to splat scene to be loaded
     * @param {object} options {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         showLoadingUI:         Display a loading spinner while the scene is loading, defaults to true
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     *         onProgress:                 Function to be called as file data are received, or other processing occurs
     *
     * }
     * @return {AbortablePromise}
     */
    addSplatScene(path, options = {}) {

        if (this.isLoadingOrUnloading()) {
            throw new Error('Cannot add splat scene while another load or unload is already in progress.');
        }

        if (this.isDisposingOrDisposed()) {
            throw new Error('Cannot add splat scene after dispose() is called.');
        }

        const format = (options.format !== undefined && options.format !== null) ? options.format : sceneFormatFromPath(path);
        const streamBuildSections = Viewer.isStreamable(format) && options.streamView;
        const showLoadingUI = (options.showLoadingUI !== undefined && options.showLoadingUI !== null) ? options.showLoadingUI : true;

        let loadingUITaskId = null;
        if (showLoadingUI) {
            this.loadingSpinner.removeAllTasks();
            loadingUITaskId = this.loadingSpinner.addTask('Downloading...');
        }
        const hideLoadingUI = () => {
            this.loadingProgressBar.hide();
            this.loadingSpinner.removeAllTasks();
        };

        const onProgressUIUpdate = (percentComplete, percentCompleteLabel, loaderStatus) => {
            if (showLoadingUI) {
                if (loaderStatus === LoaderStatus.Downloading) {
                    if (percentComplete == 100) {
                        this.loadingSpinner.setMessageForTask(loadingUITaskId, 'Download complete!');
                    } else {
                        if (streamBuildSections) {
                            this.loadingSpinner.setMessageForTask(loadingUITaskId, 'Downloading splats...');
                        } else {
                            const suffix = percentCompleteLabel ? `: ${percentCompleteLabel}` : `...`;
                            this.loadingSpinner.setMessageForTask(loadingUITaskId, `Downloading${suffix}`);
                        }
                    }
                } else if (loaderStatus === LoaderStatus.Processing) {
                    this.loadingSpinner.setMessageForTask(loadingUITaskId, 'Processing splats...');
                } else {
                    this.loadingSpinner.setMessageForTask(loadingUITaskId, 'Ready!');
                }
            }
        };

        let downloadDone = false;
        let downloadedPercentage = 0;
        const splatBuffersAddedUIUpdate = (firstBuild, finalBuild) => {
            if (showLoadingUI) {
                if (firstBuild && streamBuildSections || finalBuild && !streamBuildSections) {
                    this.runAfterFirstSort.push(() => {
                        this.loadingSpinner.removeTask(loadingUITaskId);
                        if (!finalBuild && !downloadDone) this.loadingProgressBar.show();
                    });
                }
                if (streamBuildSections) {
                    if (finalBuild) {
                        downloadDone = true;
                        this.loadingProgressBar.hide();
                    } else {
                        this.loadingProgressBar.setProgress(downloadedPercentage);
                    }
                }
            }
        };

        const onProgress = (percentComplete, percentCompleteLabel, loaderStatus) => {
            downloadedPercentage = percentComplete;
            onProgressUIUpdate(percentComplete, percentCompleteLabel, loaderStatus);
            if (options.onProgress) options.onProgress(percentComplete, percentCompleteLabel, loaderStatus);
        };

        const buildSection = (splatBuffer, firstBuild, finalBuild) => {
            if (!streamBuildSections && options.onProgress) options.onProgress(0, '0%', LoaderStatus.Processing);
            const addSplatBufferOptions = {
                'rotation': options.rotation || options.orientation,
                'position': options.position,
                'scale': options.scale,
                'splatAlphaRemovalThreshold': options.splatAlphaRemovalThreshold,
            };
            return this.addSplatBuffers([splatBuffer], [addSplatBufferOptions],
                                         finalBuild, firstBuild && showLoadingUI, showLoadingUI).then(() => {
                if (!streamBuildSections && options.onProgress) options.onProgress(100, '100%', LoaderStatus.Processing);
                splatBuffersAddedUIUpdate(firstBuild, finalBuild);
            });
        };

        const loadFunc = streamBuildSections ? this.downloadAndBuildSingleSplatSceneStreaming.bind(this) :
                                               this.downloadAndBuildSingleSplatSceneNonStreaming.bind(this);
        return loadFunc(path, format, options.splatAlphaRemovalThreshold, buildSection.bind(this), onProgress, hideLoadingUI.bind(this));
    }

    /**
     * Download a single non-streamed splat scene, convert to splat buffer and then rebuild the viewer's splat mesh
     * by calling 'buildFunc'. Also sets/clears relevant instance synchronization objects, and calls appropriate functions
     * on success or failure.
     * @param {string} path Path to splat scene to be loaded
     * @param {SceneFormat} format Format of the splat scene file
     * @param {number} splatAlphaRemovalThreshold Ignore any splats with an alpha less than the specified value (valid range: 0 - 255)
     * @param {function} buildFunc Function to build the viewer's splat mesh with the downloaded splat buffer
     * @param {function} onProgress Function to be called as file data are received, or other processing occurs
     * @param {function} onException Function to be called when exception occurs
     * @return {AbortablePromise}
     */
    downloadAndBuildSingleSplatSceneNonStreaming(path, format, splatAlphaRemovalThreshold, buildFunc, onProgress, onException) {
        const downloadPromise = this.downloadSplatSceneToSplatBuffer(path, splatAlphaRemovalThreshold, onProgress, false, undefined, format)
        .then((splatBuffer) => {
            this.removeSplatSceneDownloadPromise(downloadPromise);
            return buildFunc(splatBuffer, true, true).then(() => {
                this.clearSplatSceneDownloadAndBuildPromise();
            });
        })
        .catch((e) => {
            if (onException) onException();
            this.clearSplatSceneDownloadAndBuildPromise();
            this.removeSplatSceneDownloadPromise(downloadPromise);
            if (!(e instanceof AbortedPromiseError)) {
                throw (new Error(`Viewer::addSplatScene -> Could not load file ${path}`));
            }
        });

        this.addSplatSceneDownloadPromise(downloadPromise);
        this.setSplatSceneDownloadAndBuildPromise(downloadPromise);

        return downloadPromise;
    }

    /**
     * Download a single splat scene and convert to splat buffer in a streamed manner, allowing rendering as the file downloads.
     * As each section is downloaded, the viewer's splat mesh is rebuilt by calling 'buildFunc'
     * Also sets/clears relevant instance synchronization objects, and calls appropriate functions on success or failure.
     * @param {string} path Path to splat scene to be loaded
     * @param {SceneFormat} format Format of the splat scene file
     * @param {number} splatAlphaRemovalThreshold Ignore any splats with an alpha less than the specified value (valid range: 0 - 255)
     * @param {function} buildFunc Function to rebuild the viewer's splat mesh after a new splat buffer section is downloaded
     * @param {function} onDownloadProgress Function to be called as file data are received
     * @param {function} onDownloadException Function to be called when exception occurs at any point during the full download
     * @return {AbortablePromise}
     */
    downloadAndBuildSingleSplatSceneStreaming(path, format, splatAlphaRemovalThreshold, buildFunc,
                                              onDownloadProgress, onDownloadException) {
        let firstStreamedSectionDownloadAndBuildResolver;
        let firstStreamedSectionDownloadAndBuildRejecter;
        let splatSceneDownloadAndBuildResolver;
        let splatSceneDownloadAndBuildRejecter;
        let steamedSectionBuildCount = 0;
        let streamedSectionBuilding = false;
        const queuedStreamedSectionBuilds = [];

        const checkAndBuildStreamedSections = () => {
            if (queuedStreamedSectionBuilds.length > 0 && !streamedSectionBuilding && !this.isDisposingOrDisposed()) {
                streamedSectionBuilding = true;
                const queuedBuild = queuedStreamedSectionBuilds.shift();
                buildFunc(queuedBuild.splatBuffer, queuedBuild.firstBuild, queuedBuild.finalBuild)
                .then(() => {
                    streamedSectionBuilding = false;
                    if (queuedBuild.firstBuild) {
                        firstStreamedSectionDownloadAndBuildRejecter = null;
                        firstStreamedSectionDownloadAndBuildResolver();
                    } else if (queuedBuild.finalBuild) {
                        splatSceneDownloadAndBuildResolver();
                        this.clearSplatSceneDownloadAndBuildPromise();
                    }
                    if (queuedStreamedSectionBuilds.length > 0) delayedExecute(() => checkAndBuildStreamedSections());
                });
            }
        };

        const onStreamedSectionProgress = (splatBuffer, finalBuild) => {
            if (!this.isDisposingOrDisposed()) {
                if (finalBuild || queuedStreamedSectionBuilds.length === 0 ||
                    splatBuffer.getSplatCount() > queuedStreamedSectionBuilds[0].splatBuffer.getSplatCount()) {
                    queuedStreamedSectionBuilds.push({
                        splatBuffer,
                        firstBuild: steamedSectionBuildCount === 0,
                        finalBuild
                    });
                    steamedSectionBuildCount++;
                    checkAndBuildStreamedSections();
                }
            }
        };

        let splatSceneDownloadPromise = this.downloadSplatSceneToSplatBuffer(path, splatAlphaRemovalThreshold,
                                                                             onDownloadProgress, true, onStreamedSectionProgress, format);

        const firstStreamedSectionBuildPromise = new AbortablePromise((resolver, rejecter) => {
            firstStreamedSectionDownloadAndBuildResolver = resolver;
            firstStreamedSectionDownloadAndBuildRejecter = rejecter;
        }, splatSceneDownloadPromise.abortHandler);

        const splatSceneDownloadAndBuildPromise = new AbortablePromise((resolver, rejecter) => {
            splatSceneDownloadAndBuildResolver = resolver;
            splatSceneDownloadAndBuildRejecter = rejecter;
        });

        this.addSplatSceneDownloadPromise(splatSceneDownloadPromise);
        this.setSplatSceneDownloadAndBuildPromise(splatSceneDownloadAndBuildPromise);

        splatSceneDownloadPromise.then(() => {
            this.removeSplatSceneDownloadPromise(splatSceneDownloadPromise);
        })
        .catch((e) => {
            this.clearSplatSceneDownloadAndBuildPromise();
            this.removeSplatSceneDownloadPromise(splatSceneDownloadPromise);
            if (!(e instanceof AbortedPromiseError)) {
                splatSceneDownloadAndBuildRejecter(e);
                if (firstStreamedSectionDownloadAndBuildRejecter) firstStreamedSectionDownloadAndBuildRejecter(e);
                if (onDownloadException) onDownloadException(e);
            }
        });

        return firstStreamedSectionBuildPromise;
    }

    /**
     * Add multiple splat scenes to the viewer and display any loading UI if appropriate.
     * @param {Array<object>} sceneOptions Array of per-scene options: {
     *
     *         path: Path to splat scene to be loaded
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     * }
     * @param {boolean} showLoadingUI Display a loading spinner while the scene is loading, defaults to true
     * @param {function} onProgress Function to be called as file data are received
     * @return {AbortablePromise}
     */
    addSplatScenes(sceneOptions, showLoadingUI = true, onProgress = undefined) {

        if (this.isLoadingOrUnloading()) {
            throw new Error('Cannot add splat scene while another load or unload is already in progress.');
        }

        if (this.isDisposingOrDisposed()) {
            throw new Error('Cannot add splat scene after dispose() is called.');
        }

        const fileCount = sceneOptions.length;
        const percentComplete = [];
        if (showLoadingUI) {
            this.loadingSpinner.removeAllTasks();
            this.loadingSpinner.show();
        }
        const onLoadProgress = (fileIndex, percent, percentLabel) => {
            percentComplete[fileIndex] = percent;
            let totalPercent = 0;
            for (let i = 0; i < fileCount; i++) totalPercent += percentComplete[i] || 0;
            totalPercent = totalPercent / fileCount;
            percentLabel = `${totalPercent.toFixed(2)}%`;
            if (showLoadingUI) {
                this.loadingSpinner.setMessage(totalPercent == 100 ? `Download complete!` : `Downloading: ${percentLabel}`);
            }
            if (onProgress) onProgress(totalPercent, percentLabel, LoaderStatus.Downloading);
        };

        const downloadPromises = [];
        const nativeLoadPromises = [];
        const abortHandlers = [];
        for (let i = 0; i < sceneOptions.length; i++) {
            const options = sceneOptions[i];
            const format = (options.format !== undefined && options.format !== null) ? options.format : sceneFormatFromPath(options.path);
            const downloadPromise = this.downloadSplatSceneToSplatBuffer(options.path, options.splatAlphaRemovalThreshold,
                                                                         onLoadProgress.bind(this, i), false, undefined, format);
            abortHandlers.push(downloadPromise.abortHandler);
            downloadPromises.push(downloadPromise);
            nativeLoadPromises.push(downloadPromise.promise);
            this.addSplatSceneDownloadPromise(downloadPromise);
        }

        const downloadPromise = new AbortablePromise((resolve, reject) => {
            Promise.all(nativeLoadPromises)
            .then((splatBuffers) => {
                if (showLoadingUI) this.loadingSpinner.hide();
                if (onProgress) options.onProgress(0, '0%', LoaderStatus.Processing);
                this.addSplatBuffers(splatBuffers, sceneOptions, true, showLoadingUI, showLoadingUI).then(() => {
                    if (onProgress) onProgress(100, '100%', LoaderStatus.Processing);
                    this.clearSplatSceneDownloadAndBuildPromise();
                    resolve();
                });
            })
            .catch((e) => {
                if (showLoadingUI) this.loadingSpinner.hide();
                this.clearSplatSceneDownloadAndBuildPromise();
                if (!(e instanceof AbortedPromiseError)) {
                    reject(new Error(`Viewer::addSplatScenes -> Could not load one or more splat scenes.`));
                } else {
                    resolve();
                }
            })
            .finally(() => {
                for (let downloadPromise of downloadPromises) {
                    this.removeSplatSceneDownloadPromise(downloadPromise);
                }
            });
        }, () => {
            for (let abortHandler of abortHandlers) abortHandler();
        });
        this.setSplatSceneDownloadAndBuildPromise(downloadPromise);
        return downloadPromise;
    }

    /**
     * Download a splat scene and convert to SplatBuffer instance.
     * @param {string} path Path to splat scene to be loaded
     * @param {number} splatAlphaRemovalThreshold Ignore any splats with an alpha less than the specified
     *                                            value (valid range: 0 - 255), defaults to 1
     *
     * @param {function} onProgress Function to be called as file data are received
     * @param {boolean} streamBuiltSections Construct file sections into splat buffers as they are downloaded
     * @param {function} onSectionBuilt Function to be called when new section is added to the file
     * @param {string} format File format of the scene
     * @return {AbortablePromise}
     */
    downloadSplatSceneToSplatBuffer(path, splatAlphaRemovalThreshold = 1, onProgress = undefined,
                                    streamBuiltSections = false, onSectionBuilt = undefined, format) {
        if (format === SceneFormat.Splat) {
            return SplatLoader.loadFromURL(path, onProgress, streamBuiltSections, onSectionBuilt, splatAlphaRemovalThreshold, 0, false);
        } else if (format === SceneFormat.KSplat) {
            return KSplatLoader.loadFromURL(path, onProgress, streamBuiltSections, onSectionBuilt);
        } else if (format === SceneFormat.Ply) {
            return PlyLoader.loadFromURL(path, onProgress, streamBuiltSections, onSectionBuilt,
                                         splatAlphaRemovalThreshold, 0, this.sphericalHarmonicsDegree);
        }
        return AbortablePromise.reject(new Error(`Viewer::downloadSplatSceneToSplatBuffer -> File format not supported: ${path}`));
    }

    static isStreamable(format) {
        return format === SceneFormat.Splat || format === SceneFormat.KSplat || format === SceneFormat.Ply;
    }

    /**
     * Add one or more instances of SplatBuffer to the SplatMesh instance managed by the viewer and set up the sorting web worker.
     * This function will terminate the existing sort worker (if there is one).
     */
    addSplatBuffers = function() {

        return function(splatBuffers, splatBufferOptions = [], finalBuild = true,
                        showLoadingUI = true, showLoadingUIForSplatTreeBuild = true) {

            if (this.isDisposingOrDisposed()) return Promise.resolve();

            this.splatRenderReady = false;
            let splatProcessingTaskId = null;

            const finish = (buildResults) => {
                if (this.isDisposingOrDisposed()) return;

                if (splatProcessingTaskId !== null) {
                    this.loadingSpinner.removeTask(splatProcessingTaskId);
                    splatProcessingTaskId = null;
                }

                // If we aren't calculating the splat distances from the center on the GPU, the sorting worker needs splat centers and
                // transform indexes so that it can calculate those distance values.
                if (!this.gpuAcceleratedSort && this.sortWorker) {
                    this.sortWorker.postMessage({
                        'centers': buildResults.centers.buffer,
                        'transformIndexes': buildResults.sceneIndexes.buffer,
                        'range': {
                            'from': buildResults.from,
                            'to': buildResults.to,
                            'count': buildResults.count
                        }
                    });
                }

                this.splatRenderReady = true;
                this.sortNeededForSceneChange = true;
            };

            return new Promise((resolve) => {
                if (showLoadingUI) {
                    splatProcessingTaskId = this.loadingSpinner.addTask('Processing splats...');
                }
                delayedExecute(() => {
                    if (this.isDisposingOrDisposed()) {
                        resolve();
                    } else {
                        const buildResults = this.addSplatBuffersToMesh(splatBuffers, splatBufferOptions,
                                                                        finalBuild, showLoadingUIForSplatTreeBuild);
                        const maxSplatCount = this.splatMesh.getMaxSplatCount();
                        if (this.sortWorker && this.sortWorker.maxSplatCount !== maxSplatCount) this.disposeSortWorker();
                        const sortWorkerSetupPromise = (!this.sortWorker && maxSplatCount > 0) ?
                                                         this.setupSortWorker(this.splatMesh) : Promise.resolve();
                        sortWorkerSetupPromise.then(() => {
                            finish(buildResults);
                            resolve();
                        });
                    }
                }, true);
            });
        };

    }();

    /**
     * Add one or more instances of SplatBuffer to the SplatMesh instance managed by the viewer. This function is additive; all splat
     * buffers contained by the viewer's splat mesh before calling this function will be preserved.
     * @param {Array<SplatBuffer>} splatBuffers SplatBuffer instances
     * @param {Array<object>} splatBufferOptions Array of options objects: {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     * }
     * @param {boolean} finalBuild Will the splat mesh be in its final state after this build?
     * @param {boolean} showLoadingUIForSplatTreeBuild Whether or not to show the loading spinner during construction of the splat tree.
     * @return {object} Object containing info about the splats that are updated
     */
    addSplatBuffersToMesh(splatBuffers, splatBufferOptions, finalBuild = true, showLoadingUIForSplatTreeBuild = false) {
        if (this.isDisposingOrDisposed()) return;
        const allSplatBuffers = this.splatMesh.splatBuffers || [];
        const allSplatBufferOptions = this.splatMesh.splatBufferOptions || [];
        allSplatBuffers.push(...splatBuffers);
        allSplatBufferOptions.push(...splatBufferOptions);
        if (this.renderer) this.splatMesh.setRenderer(this.renderer);
        let splatOptimizingTaskId;
        const onSplatTreeIndexesUpload = (finished) => {
            if (this.isDisposingOrDisposed()) return;
            const splatCount = this.splatMesh.getSplatCount();
            if (showLoadingUIForSplatTreeBuild && splatCount >= MIN_SPLAT_COUNT_TO_SHOW_SPLAT_TREE_LOADING_SPINNER) {
                if (!finished && !splatOptimizingTaskId) {
                    this.loadingSpinner.setMinimized(true, true);
                    splatOptimizingTaskId = this.loadingSpinner.addTask('Optimizing splats...');
                }
            }
        };
        const onSplatTreeReady = (finished) => {
            if (this.isDisposingOrDisposed()) return;
            if (finished && splatOptimizingTaskId) {
                this.loadingSpinner.removeTask(splatOptimizingTaskId);
            }
        };
        return this.splatMesh.build(allSplatBuffers, allSplatBufferOptions, true, finalBuild, onSplatTreeIndexesUpload, onSplatTreeReady);
    }

    /**
     * Set up the splat sorting web worker.
     * @param {SplatMesh} splatMesh SplatMesh instance that contains the splats to be sorted
     * @return {Promise}
     */
    setupSortWorker(splatMesh) {
        if (this.isDisposingOrDisposed()) return;
        return new Promise((resolve) => {
            const DistancesArrayType = this.integerBasedSort ? Int32Array : Float32Array;
            const splatCount = splatMesh.getSplatCount();
            const maxSplatCount = splatMesh.getMaxSplatCount();
            this.sortWorker = createSortWorker(maxSplatCount, this.sharedMemoryForWorkers,
                                               this.integerBasedSort, this.splatMesh.dynamicMode);
            let sortCount = 0;
            this.sortWorker.onmessage = (e) => {
                if (e.data.sortDone) {
                    this.sortRunning = false;
                    if (this.sharedMemoryForWorkers) {
                        this.splatMesh.updateRenderIndexes(this.sortWorkerSortedIndexes, e.data.splatRenderCount);
                    } else {
                        const sortedIndexes = new Uint32Array(e.data.sortedIndexes.buffer, 0, e.data.splatRenderCount);
                        this.splatMesh.updateRenderIndexes(sortedIndexes, e.data.splatRenderCount);
                    }
                    this.lastSortTime = e.data.sortTime;
                    this.sortPromiseResolver();
                    this.sortPromiseResolver = null;
                    this.forceRenderNextFrame();
                    if (sortCount === 0) {
                        this.runAfterFirstSort.forEach((func) => {
                            func();
                        });
                        this.runAfterFirstSort.length = 0;
                    }
                    sortCount++;
                } else if (e.data.sortCanceled) {
                    this.sortRunning = false;
                } else if (e.data.sortSetupPhase1Complete) {
                    if (this.logLevel >= LogLevel.Info) console.log('Sorting web worker WASM setup complete.');
                    if (this.sharedMemoryForWorkers) {
                        this.sortWorkerSortedIndexes = new Uint32Array(e.data.sortedIndexesBuffer,
                                                                       e.data.sortedIndexesOffset, maxSplatCount);
                        this.sortWorkerIndexesToSort = new Uint32Array(e.data.indexesToSortBuffer,
                                                                       e.data.indexesToSortOffset, maxSplatCount);
                        this.sortWorkerPrecomputedDistances = new DistancesArrayType(e.data.precomputedDistancesBuffer,
                                                                                     e.data.precomputedDistancesOffset,
                                                                                     maxSplatCount);
                         this.sortWorkerTransforms = new Float32Array(e.data.transformsBuffer,
                                                                      e.data.transformsOffset, Constants.MaxScenes * 16);
                    } else {
                        this.sortWorkerIndexesToSort = new Uint32Array(maxSplatCount);
                        this.sortWorkerPrecomputedDistances = new DistancesArrayType(maxSplatCount);
                        this.sortWorkerTransforms = new Float32Array(Constants.MaxScenes * 16);
                    }
                    for (let i = 0; i < splatCount; i++) this.sortWorkerIndexesToSort[i] = i;
                    this.sortWorker.maxSplatCount = maxSplatCount;

                    if (this.logLevel >= LogLevel.Info) {
                        console.log('Sorting web worker ready.');
                        const splatDataTextures = this.splatMesh.getSplatDataTextures();
                        const covariancesTextureSize = splatDataTextures.covariances.size;
                        const centersColorsTextureSize = splatDataTextures.centerColors.size;
                        console.log('Covariances texture size: ' + covariancesTextureSize.x + ' x ' + covariancesTextureSize.y);
                        console.log('Centers/colors texture size: ' + centersColorsTextureSize.x + ' x ' + centersColorsTextureSize.y);
                    }

                    resolve();
                }
            };
        });
    }

    disposeSortWorker() {
        if (this.sortWorker) this.sortWorker.terminate();
        this.sortWorker = null;
        this.sortPromise = null;
        if (this.sortPromiseResolver) {
            this.sortPromiseResolver();
            this.sortPromiseResolver = null;
        }
        this.sortRunning = false;
    }

    removeSplatScene(index, showLoadingUI = true) {
        if (this.isLoadingOrUnloading()) {
            throw new Error('Cannot remove splat scene while another load or unload is already in progress.');
        }

        if (this.isDisposingOrDisposed()) {
            throw new Error('Cannot remove splat scene after dispose() is called.');
        }

        let sortPromise;

        this.splatSceneRemovalPromise = new Promise((resolve, reject) => {
            let revmovalTaskId;

            if (showLoadingUI) {
                this.loadingSpinner.removeAllTasks();
                this.loadingSpinner.show();
                revmovalTaskId = this.loadingSpinner.addTask('Removing splat scene...');
            }

            const checkAndHideLoadingUI = () => {
                if (showLoadingUI) {
                    this.loadingSpinner.hide();
                    this.loadingSpinner.removeTask(revmovalTaskId);
                }
            };

            const onDone = (error) => {
                checkAndHideLoadingUI();
                this.splatSceneRemovalPromise = null;
                if (!error) resolve();
                else reject(error);
            };

            const checkForEarlyExit = () => {
                if (this.isDisposingOrDisposed()) {
                    onDone();
                    return true;
                }
                return false;
            };

            sortPromise = this.sortPromise || Promise.resolve();
            sortPromise.then(() => {
                if (checkForEarlyExit()) return;
                const savedSplatBuffers = [];
                const savedSceneOptions = [];
                const savedSceneTransformComponents = [];
                const savedVisibleRegionFadeStartRadius = this.splatMesh.visibleRegionFadeStartRadius;
                for (let i = 0; i < this.splatMesh.scenes.length; i++) {
                    if (i !== index) {
                        const scene = this.splatMesh.scenes[i];
                        savedSplatBuffers.push(scene.splatBuffer);
                        savedSceneOptions.push(this.splatMesh.sceneOptions[i]);
                        savedSceneTransformComponents.push({
                            'position': scene.position.clone(),
                            'quaternion': scene.quaternion.clone(),
                            'scale': scene.scale.clone()
                        });
                    }
                }
                this.disposeSortWorker();
                this.splatMesh.dispose();
                this.createSplatMesh();
                this.addSplatBuffers(savedSplatBuffers, savedSceneOptions, true, false, true)
                .then(() => {
                    if (checkForEarlyExit()) return;
                    checkAndHideLoadingUI();
                    this.splatMesh.visibleRegionFadeStartRadius = savedVisibleRegionFadeStartRadius;
                    this.splatMesh.scenes.forEach((scene, index) => {
                        scene.position.copy(savedSceneTransformComponents[index].position);
                        scene.quaternion.copy(savedSceneTransformComponents[index].quaternion);
                        scene.scale.copy(savedSceneTransformComponents[index].scale);
                    });
                    this.splatMesh.updateTransforms();
                    this.splatRenderReady = false;
                    this.updateSplatSort(true)
                    .then(() => {
                        if (checkForEarlyExit()) {
                            this.splatRenderReady = true;
                            return;
                        }
                        sortPromise = this.sortPromise || Promise.resolve();
                        sortPromise.then(() => {
                            this.splatRenderReady = true;
                            onDone();
                        });
                    });
                })
                .catch((e) => {
                    onDone(e);
                });
            });
        });

        return this.splatSceneRemovalPromise;
    }

    /**
     * Start self-driven mode
     */
    start() {
        if (this.selfDrivenMode) {
            if (this.webXRMode) {
                this.renderer.setAnimationLoop(this.selfDrivenUpdateFunc);
            } else {
                this.requestFrameId = requestAnimationFrame(this.selfDrivenUpdateFunc);
            }
            this.selfDrivenModeRunning = true;
        } else {
            throw new Error('Cannot start viewer unless it is in self driven mode.');
        }
    }

    /**
     * Stop self-driven mode
     */
    stop() {
        if (this.selfDrivenMode && this.selfDrivenModeRunning) {
            if (!this.webXRMode) {
                cancelAnimationFrame(this.requestFrameId);
            }
            this.selfDrivenModeRunning = false;
        }
    }

    /**
     * Dispose of all resources held directly and indirectly by this viewer.
     */
    async dispose() {
        this.disposing = true;
        let waitPromises = [];
        let promisesToAbort = [];
        for (let promiseKey in this.splatSceneDownloadPromises) {
            if (this.splatSceneDownloadPromises.hasOwnProperty(promiseKey)) {
                const downloadPromiseToAbort = this.splatSceneDownloadPromises[promiseKey];
                promisesToAbort.push(downloadPromiseToAbort);
                waitPromises.push(downloadPromiseToAbort.promise);
            }
        }
        if (this.sortPromise) {
            waitPromises.push(this.sortPromise);
        }
        const disposePromise = Promise.all(waitPromises).finally(() => {
            this.stop();
            if (this.controls) {
                this.controls.dispose();
                this.controls = null;
            }
            if (this.splatMesh) {
                this.splatMesh.dispose();
                this.splatMesh = null;
            }
            if (this.sceneHelper) {
                this.sceneHelper.dispose();
                this.sceneHelper = null;
            }
            if (this.resizeObserver) {
                this.resizeObserver.unobserve(this.rootElement);
                this.resizeObserver = null;
            }
            this.disposeSortWorker();
            this.removeEventHandlers();

            this.loadingSpinner.removeAllTasks();
            this.loadingSpinner.setContainer(null);
            this.loadingProgressBar.hide();
            this.loadingProgressBar.setContainer(null);
            this.infoPanel.setContainer(null);

            this.camera = null;
            this.threeScene = null;
            this.splatRenderReady = false;
            this.initialized = false;
            if (this.renderer) {
                if (!this.usingExternalRenderer) {
                    this.rootElement.removeChild(this.renderer.domElement);
                    this.renderer.dispose();
                }
                this.renderer = null;
            }

            if (!this.usingExternalRenderer) {
                document.body.removeChild(this.rootElement);
            }

            this.sortWorkerSortedIndexes = null;
            this.sortWorkerIndexesToSort = null;
            this.sortWorkerPrecomputedDistances = null;
            this.sortWorkerTransforms = null;
            this.disposed = true;
            this.disposing = false;
        });
        promisesToAbort.forEach((toAbort) => {
            toAbort.abort();
        });
        return disposePromise;
    }

    selfDrivenUpdate() {
        if (this.selfDrivenMode && !this.webXRMode) {
            this.requestFrameId = requestAnimationFrame(this.selfDrivenUpdateFunc);
        }
        this.update();
        if (this.shouldRender()) {
            this.render();
            this.consecutiveRenderFrames++;
        } else {
            this.consecutiveRenderFrames = 0;
        }
        this.renderNextFrame = false;
    }

    forceRenderNextFrame() {
        this.renderNextFrame = true;
    }

    shouldRender = function() {

        let renderCount = 0;
        const lastCameraPosition = new THREE.Vector3();
        const lastCameraOrientation = new THREE.Quaternion();
        const changeEpsilon = 0.0001;

        return function() {
            let shouldRender = false;
            let cameraChanged = false;
            if (this.camera) {
                const cp = this.camera.position;
                const co = this.camera.quaternion;
                cameraChanged = Math.abs(cp.x - lastCameraPosition.x) > changeEpsilon ||
                                Math.abs(cp.y - lastCameraPosition.y) > changeEpsilon ||
                                Math.abs(cp.z - lastCameraPosition.z) > changeEpsilon ||
                                Math.abs(co.x - lastCameraOrientation.x) > changeEpsilon ||
                                Math.abs(co.y - lastCameraOrientation.y) > changeEpsilon ||
                                Math.abs(co.z - lastCameraOrientation.z) > changeEpsilon ||
                                Math.abs(co.w - lastCameraOrientation.w) > changeEpsilon;
            }

            shouldRender = this.renderMode !== RenderMode.Never && (renderCount === 0 || this.splatMesh.visibleRegionChanging ||
                           cameraChanged || this.renderMode === RenderMode.Always || this.dynamicMode === true || this.renderNextFrame);

            if (this.camera) {
                lastCameraPosition.copy(this.camera.position);
                lastCameraOrientation.copy(this.camera.quaternion);
            }

            renderCount++;
            return shouldRender;
        };

    }();

    render = function() {

        return function() {
            if (!this.initialized || !this.splatRenderReady) return;

            const hasRenderables = (threeScene) => {
                for (let child of threeScene.children) {
                    if (child.visible) return true;
                }
                return false;
            };

            const savedAuoClear = this.renderer.autoClear;
            if (hasRenderables(this.threeScene)) {
                this.renderer.render(this.threeScene, this.camera);
                this.renderer.autoClear = false;
            }
            this.renderer.render(this.splatMesh, this.camera);
            this.renderer.autoClear = false;
            if (this.sceneHelper.getFocusMarkerOpacity() > 0.0) this.renderer.render(this.sceneHelper.focusMarker, this.camera);
            if (this.showControlPlane) this.renderer.render(this.sceneHelper.controlPlane, this.camera);
            this.renderer.autoClear = savedAuoClear;
        };

    }();

    update(renderer, camera) {
        if (this.dropInMode) this.updateForDropInMode(renderer, camera);
        if (!this.initialized || !this.splatRenderReady) return;
        if (this.controls) {
            this.controls.update();
            if (this.camera.isOrthographicCamera && !this.usingExternalCamera) {
                Viewer.setCameraPositionFromZoom(this.camera, this.camera, this.controls);
            }
        }
        this.splatMesh.updateVisibleRegionFadeDistance(this.sceneRevealMode);
        this.updateSplatSort();
        this.updateForRendererSizeChanges();
        this.updateSplatMesh();
        this.updateMeshCursor();
        this.updateFPS();
        this.timingSensitiveUpdates();
        this.updateInfoPanel();
        this.updateControlPlane();
    }

    updateForDropInMode(renderer, camera) {
        this.renderer = renderer;
        if (this.splatMesh) this.splatMesh.setRenderer(this.renderer);
        this.camera = camera;
        if (this.controls) this.controls.object = camera;
        this.init();
    }

    updateFPS = function() {

        let lastCalcTime = getCurrentTime();
        let frameCount = 0;

        return function() {
            if (this.consecutiveRenderFrames > CONSECUTIVE_RENDERED_FRAMES_FOR_FPS_CALCULATION) {
                const currentTime = getCurrentTime();
                const calcDelta = currentTime - lastCalcTime;
                if (calcDelta >= 1.0) {
                    this.currentFPS = frameCount;
                    frameCount = 0;
                    lastCalcTime = currentTime;
                } else {
                    frameCount++;
                }
            } else {
                this.currentFPS = null;
            }
        };

    }();

    updateForRendererSizeChanges = function() {

        const lastRendererSize = new THREE.Vector2();
        const currentRendererSize = new THREE.Vector2();
        let lastCameraOrthographic;

        return function() {
            if (!this.usingExternalCamera) {
                this.renderer.getSize(currentRendererSize);
                if (lastCameraOrthographic === undefined || lastCameraOrthographic !== this.camera.isOrthographicCamera ||
                    currentRendererSize.x !== lastRendererSize.x || currentRendererSize.y !== lastRendererSize.y) {
                    if (this.camera.isOrthographicCamera) {
                        this.camera.left = -currentRendererSize.x / 2.0;
                        this.camera.right = currentRendererSize.x / 2.0;
                        this.camera.top = currentRendererSize.y / 2.0;
                        this.camera.bottom = -currentRendererSize.y / 2.0;
                    } else {
                        this.camera.aspect = currentRendererSize.x / currentRendererSize.y;
                    }
                    this.camera.updateProjectionMatrix();
                    lastRendererSize.copy(currentRendererSize);
                    lastCameraOrthographic = this.camera.isOrthographicCamera;
                }
            }
        };

    }();

    timingSensitiveUpdates = function() {

        let lastUpdateTime;

        return function() {
            const currentTime = getCurrentTime();
            if (!lastUpdateTime) lastUpdateTime = currentTime;
            const timeDelta = currentTime - lastUpdateTime;

            this.updateCameraTransition(currentTime);
            this.updateFocusMarker(timeDelta);

            lastUpdateTime = currentTime;
        };

    }();

    updateCameraTransition = function() {

        let tempCameraTarget = new THREE.Vector3();
        let toPreviousTarget = new THREE.Vector3();
        let toNextTarget = new THREE.Vector3();

        return function(currentTime) {
            if (this.transitioningCameraTarget) {
                toPreviousTarget.copy(this.previousCameraTarget).sub(this.camera.position).normalize();
                toNextTarget.copy(this.nextCameraTarget).sub(this.camera.position).normalize();
                const rotationAngle = Math.acos(toPreviousTarget.dot(toNextTarget));
                const rotationSpeed = rotationAngle / (Math.PI / 3) * .65 + .3;
                const t = (rotationSpeed / rotationAngle * (currentTime - this.transitioningCameraTargetStartTime));
                tempCameraTarget.copy(this.previousCameraTarget).lerp(this.nextCameraTarget, t);
                this.camera.lookAt(tempCameraTarget);
                this.controls.target.copy(tempCameraTarget);
                if (t >= 1.0) {
                    this.transitioningCameraTarget = false;
                }
            }
        };

    }();

    updateFocusMarker = function() {

        const renderDimensions = new THREE.Vector2();
        let wasTransitioning = false;

        return function(timeDelta) {
            this.getRenderDimensions(renderDimensions);
            if (this.transitioningCameraTarget) {
                this.sceneHelper.setFocusMarkerVisibility(true);
                const currentFocusMarkerOpacity = Math.max(this.sceneHelper.getFocusMarkerOpacity(), 0.0);
                let newFocusMarkerOpacity = Math.min(currentFocusMarkerOpacity + FOCUS_MARKER_FADE_IN_SPEED * timeDelta, 1.0);
                this.sceneHelper.setFocusMarkerOpacity(newFocusMarkerOpacity);
                this.sceneHelper.updateFocusMarker(this.nextCameraTarget, this.camera, renderDimensions);
                wasTransitioning = true;
                this.forceRenderNextFrame();
            } else {
                let currentFocusMarkerOpacity;
                if (wasTransitioning) currentFocusMarkerOpacity = 1.0;
                else currentFocusMarkerOpacity = Math.min(this.sceneHelper.getFocusMarkerOpacity(), 1.0);
                if (currentFocusMarkerOpacity > 0) {
                    this.sceneHelper.updateFocusMarker(this.nextCameraTarget, this.camera, renderDimensions);
                    let newFocusMarkerOpacity = Math.max(currentFocusMarkerOpacity - FOCUS_MARKER_FADE_OUT_SPEED * timeDelta, 0.0);
                    this.sceneHelper.setFocusMarkerOpacity(newFocusMarkerOpacity);
                    if (newFocusMarkerOpacity === 0.0) this.sceneHelper.setFocusMarkerVisibility(false);
                }
                if (currentFocusMarkerOpacity > 0.0) this.forceRenderNextFrame();
                wasTransitioning = false;
            }
        };

    }();

    updateMeshCursor = function() {

        const outHits = [];
        const renderDimensions = new THREE.Vector2();

        return function() {
            if (this.showMeshCursor) {
                this.forceRenderNextFrame();
                this.getRenderDimensions(renderDimensions);
                outHits.length = 0;
                this.raycaster.setFromCameraAndScreenPosition(this.camera, this.mousePosition, renderDimensions);
                this.raycaster.intersectSplatMesh(this.splatMesh, outHits);
                if (outHits.length > 0) {
                    this.sceneHelper.setMeshCursorVisibility(true);
                    this.sceneHelper.positionAndOrientMeshCursor(outHits[0].origin, this.camera);
                } else {
                    this.sceneHelper.setMeshCursorVisibility(false);
                }
            } else {
                if (this.sceneHelper.getMeschCursorVisibility()) this.forceRenderNextFrame();
                this.sceneHelper.setMeshCursorVisibility(false);
            }
        };

    }();

    updateInfoPanel = function() {

        const renderDimensions = new THREE.Vector2();

        return function() {
            if (!this.showInfo) return;
            const splatCount = this.splatMesh.getSplatCount();
            this.getRenderDimensions(renderDimensions);
            const cameraLookAtPosition = this.controls ? this.controls.target : null;
            const meshCursorPosition = this.showMeshCursor ? this.sceneHelper.meshCursor.position : null;
            const splatRenderCountPct = splatCount > 0 ? this.splatRenderCount / splatCount * 100 : 0;
            this.infoPanel.update(renderDimensions, this.camera.position, cameraLookAtPosition,
                                  this.camera.up, this.camera.isOrthographicCamera, meshCursorPosition,
                                  this.currentFPS || 'N/A', splatCount, this.splatRenderCount, splatRenderCountPct,
                                  this.lastSortTime, this.focalAdjustment, this.splatMesh.getSplatScale(),
                                  this.splatMesh.getPointCloudModeEnabled());
        };

    }();

    updateControlPlane() {
        if (this.showControlPlane) {
            this.sceneHelper.setControlPlaneVisibility(true);
            this.sceneHelper.positionAndOrientControlPlane(this.controls.target, this.camera.up);
        } else {
            this.sceneHelper.setControlPlaneVisibility(false);
        }
    }

    updateSplatSort = function() {

        const mvpMatrix = new THREE.Matrix4();
        const cameraPositionArray = [];
        const lastSortViewDir = new THREE.Vector3(0, 0, -1);
        const sortViewDir = new THREE.Vector3(0, 0, -1);
        const lastSortViewPos = new THREE.Vector3();
        const sortViewOffset = new THREE.Vector3();
        const queuedSorts = [];

        const partialSorts = [
            {
                'angleThreshold': 0.55,
                'sortFractions': [0.125, 0.33333, 0.75]
            },
            {
                'angleThreshold': 0.65,
                'sortFractions': [0.33333, 0.66667]
            },
            {
                'angleThreshold': 0.8,
                'sortFractions': [0.5]
            }
        ];

        return async function(force = false) {
            if (this.sortRunning) return;
            if (this.splatMesh.getSplatCount() <= 0) return;

            let angleDiff = 0;
            let positionDiff = 0;
            let needsRefreshForRotation = false;
            let needsRefreshForPosition = false;

            sortViewDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
            angleDiff = sortViewDir.dot(lastSortViewDir);
            positionDiff = sortViewOffset.copy(this.camera.position).sub(lastSortViewPos).length();

            if (!force) {
                if (!this.sortNeededForSceneChange && !this.splatMesh.dynamicMode && queuedSorts.length === 0) {
                    if (angleDiff <= 0.99) needsRefreshForRotation = true;
                    if (positionDiff >= 1.0) needsRefreshForPosition = true;
                    if (!needsRefreshForRotation && !needsRefreshForPosition) return;
                }
            }

            this.sortRunning = true;
            const { splatRenderCount, shouldSortAll } = this.gatherSceneNodesForSort();
            this.splatRenderCount = splatRenderCount;

            mvpMatrix.copy(this.camera.matrixWorld).invert();
            const mvpCamera = this.perspectiveCamera || this.camera;
            mvpMatrix.premultiply(mvpCamera.projectionMatrix);
            mvpMatrix.multiply(this.splatMesh.matrixWorld);

            if (this.gpuAcceleratedSort && (queuedSorts.length <= 1 || queuedSorts.length % 2 === 0)) {
                await this.splatMesh.computeDistancesOnGPU(mvpMatrix, this.sortWorkerPrecomputedDistances);
            }

            if (this.splatMesh.dynamicMode || shouldSortAll) {
                queuedSorts.push(this.splatRenderCount);
            } else {
                if (queuedSorts.length === 0) {
                    for (let partialSort of partialSorts) {
                        if (angleDiff < partialSort.angleThreshold) {
                            for (let sortFraction of partialSort.sortFractions) {
                                queuedSorts.push(Math.floor(this.splatRenderCount * sortFraction));
                            }
                            break;
                        }
                    }
                    queuedSorts.push(this.splatRenderCount);
                }
            }
            let sortCount = Math.min(queuedSorts.shift(), this.splatRenderCount);

            cameraPositionArray[0] = this.camera.position.x;
            cameraPositionArray[1] = this.camera.position.y;
            cameraPositionArray[2] = this.camera.position.z;

            const sortMessage = {
                'modelViewProj': mvpMatrix.elements,
                'cameraPosition': cameraPositionArray,
                'splatRenderCount': this.splatRenderCount,
                'splatSortCount': sortCount,
                'usePrecomputedDistances': this.gpuAcceleratedSort
            };
            if (this.splatMesh.dynamicMode) {
                this.splatMesh.fillTransformsArray(this.sortWorkerTransforms);
            }
            if (!this.sharedMemoryForWorkers) {
                sortMessage.indexesToSort = this.sortWorkerIndexesToSort;
                sortMessage.transforms = this.sortWorkerTransforms;
                if (this.gpuAcceleratedSort) {
                    sortMessage.precomputedDistances = this.sortWorkerPrecomputedDistances;
                }
            }

            this.sortPromise = new Promise((resolve) => {
                this.sortPromiseResolver = resolve;
            });

            this.sortWorker.postMessage({
                'sort': sortMessage
            });

            if (queuedSorts.length === 0) {
                lastSortViewPos.copy(this.camera.position);
                lastSortViewDir.copy(sortViewDir);
            }

            this.sortNeededForSceneChange = false;
        };

    }();

    /**
     * Determine which splats to render by checking which are inside or close to the view frustum
     */
    gatherSceneNodesForSort = function() {

        const nodeRenderList = [];
        let allSplatsSortBuffer = null;
        const tempVectorYZ = new THREE.Vector3();
        const tempVectorXZ = new THREE.Vector3();
        const tempVector = new THREE.Vector3();
        const modelView = new THREE.Matrix4();
        const baseModelView = new THREE.Matrix4();
        const sceneTransform = new THREE.Matrix4();
        const renderDimensions = new THREE.Vector3();
        const forward = new THREE.Vector3(0, 0, -1);

        const tempMax = new THREE.Vector3();
        const nodeSize = (node) => {
            return tempMax.copy(node.max).sub(node.min).length();
        };

        return function(gatherAllNodes = false) {

            this.getRenderDimensions(renderDimensions);
            const cameraFocalLength = (renderDimensions.y / 2.0) / Math.tan(this.camera.fov / 2.0 * THREE.MathUtils.DEG2RAD);
            const fovXOver2 = Math.atan(renderDimensions.x / 2.0 / cameraFocalLength);
            const fovYOver2 = Math.atan(renderDimensions.y / 2.0 / cameraFocalLength);
            const cosFovXOver2 = Math.cos(fovXOver2);
            const cosFovYOver2 = Math.cos(fovYOver2);

            const splatTree = this.splatMesh.getSplatTree();

            if (splatTree) {
                baseModelView.copy(this.camera.matrixWorld).invert();
                baseModelView.multiply(this.splatMesh.matrixWorld);

                let nodeRenderCount = 0;
                let splatRenderCount = 0;

                for (let s = 0; s < splatTree.subTrees.length; s++) {
                    const subTree = splatTree.subTrees[s];
                    modelView.copy(baseModelView);
                    if (this.splatMesh.dynamicMode) {
                        this.splatMesh.getSceneTransform(s, sceneTransform);
                        modelView.multiply(sceneTransform);
                    }
                    const nodeCount = subTree.nodesWithIndexes.length;
                    for (let i = 0; i < nodeCount; i++) {
                        const node = subTree.nodesWithIndexes[i];
                        if (!node.data || !node.data.indexes || node.data.indexes.length === 0) continue;
                        tempVector.copy(node.center).applyMatrix4(modelView);

                        const distanceToNode = tempVector.length();
                        tempVector.normalize();

                        tempVectorYZ.copy(tempVector).setX(0).normalize();
                        tempVectorXZ.copy(tempVector).setY(0).normalize();

                        const cameraAngleXZDot = forward.dot(tempVectorXZ);
                        const cameraAngleYZDot = forward.dot(tempVectorYZ);

                        const ns = nodeSize(node);
                        const outOfFovY = cameraAngleYZDot < (cosFovYOver2 - .6);
                        const outOfFovX = cameraAngleXZDot < (cosFovXOver2 - .6);
                        if (!gatherAllNodes && ((outOfFovX || outOfFovY) && distanceToNode > ns)) {
                            continue;
                        }
                        splatRenderCount += node.data.indexes.length;
                        nodeRenderList[nodeRenderCount] = node;
                        node.data.distanceToNode = distanceToNode;
                        nodeRenderCount++;
                    }
                }

                nodeRenderList.length = nodeRenderCount;
                nodeRenderList.sort((a, b) => {
                    if (a.data.distanceToNode < b.data.distanceToNode) return -1;
                    else return 1;
                });

                let currentByteOffset = splatRenderCount * Constants.BytesPerInt;
                for (let i = 0; i < nodeRenderCount; i++) {
                    const node = nodeRenderList[i];
                    const windowSizeInts = node.data.indexes.length;
                    const windowSizeBytes = windowSizeInts * Constants.BytesPerInt;
                    let destView = new Uint32Array(this.sortWorkerIndexesToSort.buffer,
                                                   currentByteOffset - windowSizeBytes, windowSizeInts);
                    destView.set(node.data.indexes);
                    currentByteOffset -= windowSizeBytes;
                }

                return {
                    'splatRenderCount': splatRenderCount,
                    'shouldSortAll': false
                };
            } else {
                const totalSplatCount = this.splatMesh.getSplatCount();
                if (!allSplatsSortBuffer || allSplatsSortBuffer.length !== totalSplatCount) {
                    allSplatsSortBuffer = new Uint32Array(totalSplatCount);
                    for (let i = 0; i < totalSplatCount; i++) {
                        allSplatsSortBuffer[i] = i;
                    }
                }
                this.sortWorkerIndexesToSort.set(allSplatsSortBuffer);
                return {
                    'splatRenderCount': totalSplatCount,
                    'shouldSortAll': true
                };
            }
        };

    }();

    getSplatMesh() {
        return this.splatMesh;
    }

    /**
     * Get a reference to a splat scene.
     * @param {number} sceneIndex The index of the scene to which the reference will be returned
     * @return {SplatScene}
     */
    getSplatScene(sceneIndex) {
        return this.splatMesh.getScene(sceneIndex);
    }

    isMobile() {
        return navigator.userAgent.includes('Mobi');
    }
}

/**
 * DropInViewer: Wrapper for a Viewer instance that enables it to be added to a Three.js scene like
 * any other Three.js scene object (Mesh, Object3D, etc.)
 */
class DropInViewer extends THREE.Group {

    constructor(options = {}) {
        super();

        options.selfDrivenMode = false;
        options.useBuiltInControls = false;
        options.rootElement = null;
        options.ignoreDevicePixelRatio = false;
        options.dropInMode = true;
        options.camera = undefined;
        options.renderer = undefined;

        this.viewer = new Viewer(options);
        this.splatMesh = null;

        this.callbackMesh = DropInViewer.createCallbackMesh();
        this.add(this.callbackMesh);
        this.callbackMesh.onBeforeRender = DropInViewer.onBeforeRender.bind(this, this.viewer);

    }

    /**
     * Add a single splat scene to the viewer.
     * @param {string} path Path to splat scene to be loaded
     * @param {object} options {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         showLoadingUI:         Display a loading spinner while the scene is loading, defaults to true
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     *         onProgress:                 Function to be called as file data are received
     *
     * }
     * @return {AbortablePromise}
     */
    addSplatScene(path, options = {}) {
        if (options.showLoadingUI !== false) options.showLoadingUI = true;
        return this.viewer.addSplatScene(path, options);
    }

    /**
     * Add multiple splat scenes to the viewer.
     * @param {Array<object>} sceneOptions Array of per-scene options: {
     *
     *         path: Path to splat scene to be loaded
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     * }
     * @param {boolean} showLoadingUI Display a loading spinner while the scene is loading, defaults to true
     * @return {AbortablePromise}
     */
    addSplatScenes(sceneOptions, showLoadingUI) {
        if (showLoadingUI !== false) showLoadingUI = true;
        return this.viewer.addSplatScenes(sceneOptions, showLoadingUI);
    }

    /**
     * Get a reference to a splat scene.
     * @param {number} sceneIndex The index of the scene to which the reference will be returned
     * @return {SplatScene}
     */
    getSplatScene(sceneIndex) {
        return this.viewer.getSplatScene(sceneIndex);
    }

    removeSplatScene(index) {
        return this.viewer.removeSplatScene(index);
    }

    dispose() {
        return this.viewer.dispose();
    }

    static onBeforeRender(viewer, renderer, threeScene, camera) {
        if (this.splatMesh !== this.viewer.splatMesh) {
            if (this.splatMesh) {
                this.remove(this.splatMesh);
            }
            this.splatMesh = this.viewer.splatMesh;
            this.add(this.viewer.splatMesh);
        }
        viewer.update(renderer, camera);
    }

    static createCallbackMesh() {
        const geometry = new THREE.SphereGeometry(1, 8, 8);
        const material = new THREE.MeshBasicMaterial();
        material.colorWrite = false;
        material.depthWrite = false;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        return mesh;
    }

}

export { AbortablePromise, CompressedPlyParser, DropInViewer, KSplatLoader, Utils as LoaderUtils, LogLevel, OrbitControls, PlyLoader, PlyParser, RenderMode, SceneFormat, SceneRevealMode, SplatBuffer, SplatBufferGenerator, SplatLoader, SplatParser, SplatPartitioner, Viewer, WebXRMode };
//# sourceMappingURL=gaussian-splats-3d.module.js.map
