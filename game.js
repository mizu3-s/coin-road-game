// ==========================================
// 「進んで！コインロード」ゲームロジック（完全改善版・修正）
// ==========================================

// --- グローバルエラーキャッチ ---
window.onerror = function(message, source, lineno, colno, error) {
    const consoleDiv = document.getElementById('debug-error-console');
    const textPre = document.getElementById('debug-error-text');
    if (consoleDiv && textPre) {
        consoleDiv.style.display = 'block';
        textPre.textContent = `${message}\nat ${source}:${lineno}:${colno}\n\nStack: ${error ? error.stack : 'N/A'}`;
    }
    console.error("Global Error Caught:", message, "at", source, ":", lineno);
    return false;
};

// --- 道路セグメント定義 (10mごと) ---
// 0: full, 1: narrow (細い道), 2: split (中央に穴), 3: gap (完全な隙間)
const ROAD_SEGMENTS = {};
for (let i = 0; i <= 30; i++) {
    const zKey = -i * 10;
    ROAD_SEGMENTS[zKey] = 'full';
}
ROAD_SEGMENTS[-50] = 'split';  // Z = -50〜-60 は中央に穴
ROAD_SEGMENTS[-60] = 'split';
ROAD_SEGMENTS[-100] = 'narrow'; // Z = -100〜-110 は細い道
ROAD_SEGMENTS[-140] = 'split';  // Z = -140〜-150 は中央に穴
ROAD_SEGMENTS[-150] = 'split';
ROAD_SEGMENTS[-200] = 'narrow'; // Z = -200〜-210 は細い道
ROAD_SEGMENTS[-230] = 'gap';    // Z = -230〜-240 は道が途切れている
ROAD_SEGMENTS[-260] = 'split';  // Z = -260〜-270 は中央に穴

// --- ゲーム状態管理 ---
const gameState = {
    mode: 'lobby', // 'lobby', 'playing', 'result'
    score: 0,
    playerName: 'PLAYER-1',
    distance: 300, // 残り距離 (メートル)
    scrollSpeed: 0.05, // 自動前進速度をさらに遅く調整 (m/frame)
    cameraBaseZ: 0, // カメラのスクロール基準Z座標
    playerZ: 0, // プレイヤーの絶対Z座標
    playerX: 0, // プレイヤーの絶対X座標
    relativeX: 0, // 姿勢推定による相対X (左右ステップ)
    relativeZ: 0, // 姿勢推定による相対Z (前後ステップ)
    targetX: 0,
    targetZ: 0,
    shoulderWidthRef: null, // キャリブレーション用基準肩幅
    isCameraReady: false,
    isModelLoaded: false,
    
    // アニメーション用移動状態
    legSwingTime: 0, 
    
    // プレイヤーの特殊状態
    isFalling: false, // 落下中フラグ
    fallY: 0, // 落下時のY座標
    respawnTimer: 0, // リスポーン待ち時間 (2秒間 = 120フレーム)
    invincibleTimer: 0 // 被弾後の無敵フレームタイマー
};

// --- 定数定義 ---
const ROAD_WIDTH = 8;
const ROAD_LENGTH = 300;
const COLLISION_RADIUS = 0.8;

// --- Three.js グローバル変数 ---
let scene, camera, renderer;
let roadSegments = [];
let playerGroup, goalFlag;
let coins = [];
let obstacles = [];
let particles = [];
let lights = [];
let floatingHills = [];

// --- TensorFlow.js / MoveNet 関連変数 ---
let detector;
let webcamElement;
let poseCanvas, poseCtx;

// ==========================================
// 1. 初期化処理
// ==========================================

window.addEventListener('DOMContentLoaded', async () => {
    webcamElement = document.getElementById('webcam');
    poseCanvas = document.getElementById('pose-canvas');
    poseCtx = poseCanvas.getContext('2d');
    
    document.getElementById('start-btn').addEventListener('click', startGame);
    document.getElementById('retry-btn').addEventListener('click', resetToLobby);
    document.getElementById('player-name').addEventListener('input', (e) => {
        gameState.playerName = e.target.value || 'PLAYER-1';
    });

    init3D();

    updateStatus('AIモデルを読み込み中...', 'red');
    await initPoseDetection();
});

function updateStatus(text, dotColor) {
    const dot = document.querySelector('.status-dot');
    const txt = document.querySelector('.status-text');
    if (dot && txt) {
        dot.className = `status-dot ${dotColor}`;
        txt.textContent = text;
    }
}

// ==========================================
// 2. Three.js (3D空間) の構築
// ==========================================

function init3D() {
    try {
        const container = document.getElementById('game-canvas');
        scene = new THREE.Scene();
        
        scene.background = new THREE.Color(0xa0e0ff);
        scene.fog = new THREE.FogExp2(0xa0e0ff, 0.012);

        camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        
        renderer = new THREE.WebGLRenderer({ canvas: container, antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.shadowMap.enabled = true;

        const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
        scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(10, 20, 10);
        dirLight.castShadow = true;
        scene.add(dirLight);

        const spotLight = new THREE.SpotLight(0xffffff, 1.5);
        spotLight.position.set(0, 8, 0);
        spotLight.angle = Math.PI / 4;
        spotLight.penumbra = 0.5;
        spotLight.castShadow = true;
        scene.add(spotLight);
        lights.playerSpot = spotLight;

        createRoad();
        createPlayer();
        buildCourse();
        createBackgroundHills();

        window.addEventListener('resize', onWindowResize);
        
        camera.position.set(0, 4.5, 5.0);
        camera.lookAt(new THREE.Vector3(0, 0.5, -10.0));
        renderer.render(scene, camera);
        
    } catch (e) {
        console.error("Three.js Init Error:", e);
        window.onerror(e.message, "game.js (init3D)", 0, 0, e);
    }
}

function createRoad() {
    roadSegments.forEach(seg => scene.remove(seg));
    roadSegments = [];

    const tileLength = 10.0;
    const stoneMat = new THREE.MeshStandardMaterial({
        color: 0xd0d0d0,
        roughness: 0.7,
        metalness: 0.1
    });
    
    const sideRailMat = new THREE.MeshStandardMaterial({ color: 0x90caf9 });

    for (let i = 0; i < ROAD_LENGTH / tileLength; i++) {
        const startZ = -i * tileLength;
        const centerZ = startZ - tileLength / 2;
        const type = ROAD_SEGMENTS[startZ] || 'full';

        const segmentGroup = new THREE.Group();

        if (type === 'full') {
            const geo = new THREE.BoxGeometry(ROAD_WIDTH, 0.2, tileLength);
            const mesh = new THREE.Mesh(geo, stoneMat);
            mesh.position.set(0, -0.1, centerZ);
            mesh.receiveShadow = true;
            segmentGroup.add(mesh);

            const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, tileLength), sideRailMat);
            leftRail.position.set(-ROAD_WIDTH / 2, 0.1, centerZ);
            segmentGroup.add(leftRail);

            const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, tileLength), sideRailMat);
            rightRail.position.set(ROAD_WIDTH / 2, 0.1, centerZ);
            segmentGroup.add(rightRail);

        } else if (type === 'narrow') {
            const geo = new THREE.BoxGeometry(3.0, 0.2, tileLength);
            const mesh = new THREE.Mesh(geo, stoneMat);
            mesh.position.set(0, -0.1, centerZ);
            mesh.receiveShadow = true;
            segmentGroup.add(mesh);

            const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.4, tileLength), sideRailMat);
            leftRail.position.set(-1.5, 0.1, centerZ);
            segmentGroup.add(leftRail);

            const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.4, tileLength), sideRailMat);
            rightRail.position.set(1.5, 0.1, centerZ);
            segmentGroup.add(rightRail);

        } else if (type === 'split') {
            const sideWidth = 2.5;
            const gapWidth = 3.0;
            const posX = gapWidth/2 + sideWidth/2;

            const leftGeo = new THREE.BoxGeometry(sideWidth, 0.2, tileLength);
            const leftMesh = new THREE.Mesh(leftGeo, stoneMat);
            leftMesh.position.set(-posX, -0.1, centerZ);
            leftMesh.receiveShadow = true;
            segmentGroup.add(leftMesh);

            const rightGeo = new THREE.BoxGeometry(sideWidth, 0.2, tileLength);
            const rightMesh = new THREE.Mesh(rightGeo, stoneMat);
            rightMesh.position.set(posX, -0.1, centerZ);
            rightMesh.receiveShadow = true;
            segmentGroup.add(rightMesh);

            const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, tileLength), sideRailMat);
            leftRail.position.set(-ROAD_WIDTH / 2, 0.1, centerZ);
            segmentGroup.add(leftRail);

            const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, tileLength), sideRailMat);
            rightRail.position.set(ROAD_WIDTH / 2, 0.1, centerZ);
            segmentGroup.add(rightRail);

            const warnMat = new THREE.MeshStandardMaterial({ color: 0xffb300 });
            const leftInnerRail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, tileLength), warnMat);
            leftInnerRail.position.set(-(gapWidth/2), 0.05, centerZ);
            segmentGroup.add(leftInnerRail);

            const rightInnerRail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, tileLength), warnMat);
            rightInnerRail.position.set(gapWidth/2, 0.05, centerZ);
            segmentGroup.add(rightInnerRail);

        } else if (type === 'gap') {
            const thinRailMat = new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8 });
            const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, tileLength), thinRailMat);
            leftRail.position.set(-ROAD_WIDTH/2, -0.1, centerZ);
            segmentGroup.add(leftRail);

            const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, tileLength), thinRailMat);
            rightRail.position.set(ROAD_WIDTH/2, -0.1, centerZ);
            segmentGroup.add(rightRail);
        }

        scene.add(segmentGroup);
        roadSegments.push(segmentGroup);
    }
}

function createBackgroundHills() {
    floatingHills.forEach(h => scene.remove(h));
    floatingHills = [];

    const hillMat = new THREE.MeshStandardMaterial({
        color: 0x7cb342,
        roughness: 0.9,
        metalness: 0.0
    });
    
    const dirtMat = new THREE.MeshStandardMaterial({
        color: 0x8d6e63,
        roughness: 0.9
    });

    for (let i = 0; i < 12; i++) {
        const island = new THREE.Group();

        const grass = new THREE.Mesh(new THREE.SphereGeometry(15, 8, 8), hillMat);
        grass.scale.set(1.5, 0.3, 1.5);
        island.add(grass);

        const dirt = new THREE.Mesh(new THREE.ConeGeometry(13, 18, 5), dirtMat);
        dirt.position.y = -8;
        dirt.rotation.x = Math.PI;
        island.add(dirt);

        const side = i % 2 === 0 ? 1 : -1;
        const posX = side * (35 + Math.random() * 20);
        const posY = -25 - Math.random() * 15;
        const posZ = -i * 30 - 20;

        island.position.set(posX, posY, posZ);
        scene.add(island);
        floatingHills.push(island);
    }
}

function createPlayer() {
    playerGroup = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x00a8ff, metalness: 0.8, roughness: 0.2, transparent: true });
    const jointMat = new THREE.MeshStandardMaterial({ color: 0x3f3f3f, metalness: 0.5, roughness: 0.5, transparent: true });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9, roughness: 0.1, transparent: true });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true });

    playerGroup.materials = [bodyMat, jointMat, headMat, eyeMat];

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.5), bodyMat);
    torso.position.y = 1.0;
    torso.castShadow = true;
    playerGroup.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 16), headMat);
    head.position.y = 1.7;
    head.castShadow = true;
    playerGroup.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.1), eyeMat);
    visor.position.set(0, 1.7, 0.3);
    playerGroup.add(visor);

    const leftLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.8), jointMat);
    leftLeg.position.set(-0.25, 0.4, 0);
    leftLeg.castShadow = true;
    playerGroup.add(leftLeg);
    playerGroup.leftLeg = leftLeg;

    const rightLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.8), jointMat);
    rightLeg.position.set(0.25, 0.4, 0);
    rightLeg.castShadow = true;
    playerGroup.add(rightLeg);
    playerGroup.rightLeg = rightLeg;

    const leftArm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.8), bodyMat);
    leftArm.position.set(-0.55, 1.0, 0);
    leftArm.castShadow = true;
    playerGroup.add(leftArm);
    playerGroup.leftArm = leftArm;

    const rightArm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.8), bodyMat);
    rightArm.position.set(0.55, 1.0, 0);
    rightArm.castShadow = true;
    playerGroup.add(rightArm);
    playerGroup.rightArm = rightArm;

    playerGroup.position.set(0, 0, 0);
    scene.add(playerGroup);
}

// ==========================================
// 3. 各種敵キャラクターのクラス定義
// ==========================================

// 1. ドッスン (Thwomp)
class Thwomp {
    constructor(x, z) {
        this.type = 'thwomp';
        this.group = new THREE.Group();
        
        const stoneGeo = new THREE.BoxGeometry(1.6, 2.0, 1.2);
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0x777777,
            roughness: 0.9,
            metalness: 0.1
        });
        const stone = new THREE.Mesh(stoneGeo, stoneMat);
        stone.castShadow = true;
        stone.receiveShadow = true;
        this.group.add(stone);

        const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const leftEye = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.1), eyeMat);
        leftEye.position.set(-0.4, 0.3, 0.61);
        const rightEye = leftEye.clone();
        rightEye.position.x = 0.4;
        this.group.add(leftEye);
        this.group.add(rightEye);

        const hornGeo = new THREE.ConeGeometry(0.15, 0.3, 4);
        const hornMat = new THREE.MeshStandardMaterial({ color: 0x999999 });
        for (let i = -1; i <= 1; i += 2) {
            const horn = new THREE.Mesh(hornGeo, hornMat);
            horn.position.set(i * 0.5, 1.15, 0);
            this.group.add(horn);
        }

        this.group.position.set(x, 5.0, z);
        scene.add(this.group);

        this.originalY = 5.0;
        this.state = 'idle';
        this.timer = 0;
    }

    update(playerZ) {
        const distanceToPlayer = Math.abs(this.group.position.z - playerZ);

        switch (this.state) {
            case 'idle':
                if (playerZ > this.group.position.z && distanceToPlayer < 15.0) {
                    this.state = 'falling';
                }
                break;
            case 'falling':
                this.group.position.y -= 0.4;
                if (this.group.position.y <= 1.0) {
                    this.group.position.y = 1.0;
                    this.state = 'ground';
                    this.timer = 40;
                    triggerCameraShake(0.3);
                }
                break;
            case 'ground':
                this.timer--;
                if (this.timer <= 0) {
                    this.state = 'rising';
                }
                break;
            case 'rising':
                this.group.position.y += 0.05;
                if (this.group.position.y >= this.originalY) {
                    this.group.position.y = this.originalY;
                    this.state = 'idle';
                }
                break;
        }
    }

    getCollisionBox() {
        return {
            x: this.group.position.x,
            y: this.group.position.y,
            z: this.group.position.z,
            radius: 1.2
        };
    }

    destroy() {
        scene.remove(this.group);
    }
}

// 2. バッタン (Whomp)
class Whomp {
    constructor(x, z) {
        this.type = 'whomp';
        this.group = new THREE.Group();

        const bodyGeo = new THREE.BoxGeometry(2.0, 3.0, 0.4);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 1.5;
        body.castShadow = true;
        this.group.add(body);

        const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
        const leftEye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.1), eyeMat);
        leftEye.position.set(-0.4, 2.2, 0.21);
        const rightEye = leftEye.clone();
        rightEye.position.x = 0.4;
        this.group.add(leftEye);
        this.group.add(rightEye);

        this.group.position.set(x, 0.0, z);
        scene.add(this.group);

        this.state = 'idle';
        this.timer = 0;
        this.angle = 0;
    }

    update(playerZ) {
        const distanceToPlayer = Math.abs(this.group.position.z - playerZ);

        switch (this.state) {
            case 'idle':
                if (playerZ > this.group.position.z && distanceToPlayer < 12.0) {
                    this.state = 'falling';
                }
                break;
            case 'falling':
                this.angle += 0.09;
                if (this.angle >= Math.PI / 2) {
                    this.angle = Math.PI / 2;
                    this.state = 'flat';
                    this.timer = 60;
                    triggerCameraShake(0.25);
                }
                this.group.rotation.x = this.angle;
                break;
            case 'flat':
                this.timer--;
                if (this.timer <= 0) {
                    this.state = 'rising';
                }
                break;
            case 'rising':
                this.angle -= 0.02;
                if (this.angle <= 0) {
                    this.angle = 0;
                    this.state = 'idle';
                }
                this.group.rotation.x = this.angle;
                break;
        }
    }

    getCollisionBox() {
        const isFlat = this.state === 'flat' || (this.state === 'falling' && this.angle > Math.PI / 4);
        return {
            x: this.group.position.x,
            y: isFlat ? 0.2 : 1.5,
            z: isFlat ? this.group.position.z - 1.5 : this.group.position.z,
            radius: 1.2
        };
    }

    destroy() {
        scene.remove(this.group);
    }
}

// 3. ゴロー / ダイゴロー (Rock / GiantRock)
class Rock {
    constructor(x, z, isGiant = false) {
        this.type = 'rock';
        this.isGiant = isGiant;
        
        const radius = isGiant ? 1.8 : 0.8;
        const color = isGiant ? 0x8b0000 : 0x777777;
        
        const geo = new THREE.SphereGeometry(radius, 12, 12);
        const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.9 });
        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        
        this.mesh.position.set(x, radius, z);
        scene.add(this.mesh);

        this.radius = radius;
        this.active = false;
    }

    update(playerZ) {
        const distanceToPlayer = Math.abs(this.mesh.position.z - playerZ);

        if (!this.active && playerZ > this.mesh.position.z && distanceToPlayer < 25.0) {
            this.active = true;
        }

        if (this.active) {
            const speed = this.isGiant ? 0.22 : 0.15;
            this.mesh.position.z += speed;
            this.mesh.rotation.x += speed / this.radius;
        }
    }

    getCollisionBox() {
        return {
            x: this.mesh.position.x,
            y: this.mesh.position.y,
            z: this.mesh.position.z,
            radius: this.radius
        };
    }

    destroy() {
        scene.remove(this.mesh);
    }
}

// 4. キラー砲台とキラー (BulletBill)
class BulletBill {
    constructor(x, z, direction = -1) {
        this.type = 'bullet_bill';
        this.direction = direction;
        this.group = new THREE.Group();

        const baseGeo = new THREE.CylinderGeometry(0.4, 0.4, 1.4, 16);
        const blackMat = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, metalness: 0.8, roughness: 0.2 });
        const base = new THREE.Mesh(baseGeo, blackMat);
        base.position.y = 0.7;
        this.group.add(base);

        const headGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 16);
        const head = new THREE.Mesh(headGeo, blackMat);
        head.rotation.z = Math.PI / 2;
        head.position.set(direction * 0.2, 1.1, 0);
        this.group.add(head);

        const posX = direction === -1 ? ROAD_WIDTH / 2 + 0.5 : -ROAD_WIDTH / 2 - 0.5;
        this.group.position.set(posX, 0, z);
        scene.add(this.group);

        this.bullet = null;
        this.hasFired = false;
    }

    update(playerZ) {
        const distanceToPlayer = Math.abs(this.group.position.z - playerZ);

        if (!this.hasFired && playerZ > this.group.position.z && distanceToPlayer < 20.0) {
            this.fire();
        }

        if (this.bullet) {
            this.bullet.position.x += this.direction * 0.15;
            this.bullet.rotation.y += 0.1;
            
            if (Math.abs(this.bullet.position.x) > ROAD_WIDTH + 2.0) {
                scene.remove(this.bullet);
                this.bullet = null;
            }
        }
    }

    fire() {
        this.hasFired = true;
        
        const bulletGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.6, 16);
        const bulletMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9, roughness: 0.1 });
        const bullet = new THREE.Mesh(bulletGeo, bulletMat);
        
        bullet.rotation.z = Math.PI / 2;
        bullet.position.set(this.group.position.x - this.direction * 0.5, 1.1, this.group.position.z);
        scene.add(bullet);
        this.bullet = bullet;
    }

    getCollisionBox() {
        if (this.bullet) {
            return {
                x: this.bullet.position.x,
                y: this.bullet.position.y,
                z: this.bullet.position.z,
                radius: 0.6
            };
        }
        return null;
    }

    destroy() {
        scene.remove(this.group);
        if (this.bullet) {
            scene.remove(this.bullet);
        }
    }
}

// 5. カベヘイ (SpikeWall)
class SpikeWall {
    constructor(z) {
        this.type = 'spike_wall';
        this.group = new THREE.Group();

        const wallGeo = new THREE.BoxGeometry(3.0, 1.8, 0.3);
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.8 });
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.y = 0.9;
        wall.castShadow = true;
        this.group.add(wall);

        const spikeGeo = new THREE.ConeGeometry(0.12, 0.4, 4);
        const spikeMat = new THREE.MeshStandardMaterial({ color: 0xff3333 });
        for (let i = -1.2; i <= 1.2; i += 0.6) {
            const spike = new THREE.Mesh(spikeGeo, spikeMat);
            spike.rotation.x = Math.PI / 2;
            spike.position.set(i, 0.9, 0.2);
            this.group.add(spike);
        }

        this.group.position.set(0, 0, z);
        scene.add(this.group);

        this.direction = 1;
        this.speed = 0.05;
        this.range = ROAD_WIDTH / 2 - 1.5;
    }

    update() {
        this.group.position.x += this.direction * this.speed;
        if (Math.abs(this.group.position.x) >= this.range) {
            this.direction *= -1;
        }
    }

    getCollisionBox() {
        return {
            x: this.group.position.x,
            y: 0.9,
            z: this.group.position.z,
            radius: 1.5
        };
    }

    destroy() {
        scene.remove(this.group);
    }
}

// ==========================================
// 4. コース上のコイン・敵キャラクター配置
// ==========================================

function buildCourse() {
    try {
        function spawnCoin(x, z, isHidden = false) {
            const coinGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.08, 16);
            const coinMat = new THREE.MeshStandardMaterial({
                color: 0xffd700,
                metalness: 0.9,
                roughness: 0.1,
                emissive: 0xffa500,
                emissiveIntensity: 0.2
            });
            const coin = new THREE.Mesh(coinGeo, coinMat);
            coin.rotation.x = Math.PI / 2;
            
            if (isHidden) {
                coin.position.set(x, -1.0, z);
                coin.scale.set(0.01, 0.01, 0.01);
                coin.isHidden = true;
                coin.targetY = 0.6;
            } else {
                coin.position.set(x, 0.6, z);
                coin.isHidden = false;
            }
            
            coin.castShadow = true;
            scene.add(coin);
            coins.push(coin);
        }

        // --- 固定配置パターン設計 (一の位を0に揃えてバグ修正) ---
        // Z = -10, -20, -30 ... -280 のループ
        for (let z = -10; z > -290; z -= 10) {
            if (z === -20) {
                spawnCoin(0, z);
                spawnCoin(1.5, z - 3);
                spawnCoin(-1.5, z - 3);
            }
            else if (z === -40) {
                obstacles.push(new Thwomp(0, z));
                spawnCoin(-2.0, z, true);
                spawnCoin(2.0, z, true);
            }
            else if (z === -60) {
                obstacles.push(new SpikeWall(z));
                spawnCoin(0, z - 4);
            }
            else if (z === -90) {
                obstacles.push(new Whomp(-1.5, z));
                spawnCoin(2.0, z);
                spawnCoin(2.0, z - 3);
            }
            else if (z === -120) {
                obstacles.push(new BulletBill(0, z, -1));
                spawnCoin(-1.5, z);
                spawnCoin(0, z - 2);
            }
            else if (z === -150) {
                obstacles.push(new Rock(0, z, true));
                spawnCoin(-2.5, z + 5, true);
                spawnCoin(2.5, z + 5, true);
            }
            else if (z === -180) {
                obstacles.push(new Whomp(-2.0, z));
                obstacles.push(new Whomp(2.0, z));
                spawnCoin(0, z, true);
            }
            else if (z === -210) {
                obstacles.push(new BulletBill(0, z, 1));
                obstacles.push(new BulletBill(0, z - 10, -1));
                spawnCoin(-1.0, z);
                spawnCoin(1.0, z - 5);
            }
            else if (z === -240) {
                obstacles.push(new Thwomp(-2.0, z));
                obstacles.push(new Thwomp(2.0, z));
                obstacles.push(new SpikeWall(z - 10));
                spawnCoin(0, z, true);
                spawnCoin(0, z - 5, true);
            }
            else if (z === -270) {
                obstacles.push(new Rock(-2.0, z, false));
                obstacles.push(new Rock(2.0, z, false));
                spawnCoin(-1.0, z - 3, true);
                spawnCoin(0, z - 4, true);
                spawnCoin(1.0, z - 3, true);
            }
        }

        // ゴールフラッグ
        const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 4, 8);
        const poleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8 });
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(0, 2, -ROAD_LENGTH);
        
        const flagGeo = new THREE.BoxGeometry(1.5, 0.8, 0.05);
        const flagMat = new THREE.MeshStandardMaterial({ color: 0x22ed73, emissive: 0x116622, emissiveIntensity: 0.2 });
        const flag = new THREE.Mesh(flagGeo, flagMat);
        flag.position.set(0.7, 3.4, -ROAD_LENGTH);

        goalFlag = new THREE.Group();
        goalFlag.add(pole);
        goalFlag.add(flag);
        scene.add(goalFlag);

    } catch (e) {
        console.error("BuildCourse Error:", e);
        window.onerror(e.message, "game.js (buildCourse)", 0, 0, e);
    }
}

// コイン獲得時のパーティクル
function spawnExplosion(pos) {
    const particleCount = 10;
    const geometry = new THREE.SphereGeometry(0.06, 8, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xffd700 });

    for (let i = 0; i < particleCount; i++) {
        const particle = new THREE.Mesh(geometry, material);
        particle.position.copy(pos);
        
        particle.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.15,
            (Math.random() * 0.15) + 0.05,
            (Math.random() - 0.5) * 0.15
        );
        particle.life = 25;
        
        scene.add(particle);
        particles.push(particle);
    }
}

// ダメージ数値ポップアップ
function showDamageText(scoreX, scoreY, scoreZ) {
    const vector = new THREE.Vector3(scoreX, scoreY + 2.0, scoreZ);
    vector.project(camera);

    const x = (vector.x *  .5 + .5) * window.innerWidth;
    const y = (vector.y * -.5 + .5) * window.innerHeight;

    const dmgEl = document.createElement('div');
    dmgEl.className = 'damage-pop';
    dmgEl.style.position = 'absolute';
    dmgEl.style.left = `${x}px`;
    dmgEl.style.top = `${y}px`;
    dmgEl.style.color = '#ff3333';
    dmgEl.style.fontSize = '2.5rem';
    dmgEl.style.fontWeight = '900';
    dmgEl.style.textShadow = '0 0 10px rgba(255, 0, 0, 0.8), 0 0 20px rgba(0, 0, 0, 0.9)';
    dmgEl.style.fontFamily = "'Orbitron', sans-serif";
    dmgEl.style.pointerEvents = 'none';
    dmgEl.style.transform = 'translate(-50%, -50%)';
    dmgEl.textContent = '-3';
    dmgEl.style.animation = 'damageFloat 0.8s ease-out forwards';
    
    if (!document.getElementById('damage-keyframes')) {
        const style = document.createElement('style');
        style.id = 'damage-keyframes';
        style.innerHTML = `
            @keyframes damageFloat {
                0% { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
                15% { transform: translate(-50%, -80%) scale(1.3); opacity: 1; }
                100% { transform: translate(-50%, -150%) scale(1.0); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(dmgEl);
    setTimeout(() => dmgEl.remove(), 800);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ==========================================
// 5. TensorFlow.js & MoveNet (姿勢推定)
// ==========================================

async function initPoseDetection() {
    try {
        const detectorConfig = {
            modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING
        };
        detector = await poseDetection.createDetector(
            poseDetection.SupportedModels.MoveNet,
            detectorConfig
        );
        gameState.isModelLoaded = true;
        updateStatus('カメラを起動中...', 'red');
        await setupWebcam();
    } catch (e) {
        console.error(e);
        updateStatus('エラー: カメラ/AIの初期化失敗', 'red');
    }
}

async function setupWebcam() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
        });
        webcamElement.srcObject = stream;

        await new Promise((resolve) => {
            webcamElement.onloadedmetadata = () => resolve(webcamElement);
        });

        webcamElement.play();
        
        poseCanvas.width = webcamElement.videoWidth;
        poseCanvas.height = webcamElement.videoHeight;
        
        gameState.isCameraReady = true;
        updateStatus('準備完了！', 'green');
        document.getElementById('start-btn').removeAttribute('disabled');

        detectPoseLoop();
    } catch (e) {
        console.error('カメラ起動エラー:', e);
        updateStatus('カメラへのアクセスを許可してください', 'red');
    }
}

async function detectPoseLoop() {
    try {
        if (webcamElement.readyState >= 2) {
            const poses = await detector.estimatePoses(webcamElement, {
                maxPoses: 1,
                flipHorizontal: false
            });

            drawPose(poses);

            if (poses.length > 0) {
                processPoseData(poses[0]);
            }
        }
    } catch (e) {
        console.error("Pose detection loop error:", e);
    }
    requestAnimationFrame(detectPoseLoop);
}

function drawPose(poses) {
    poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
    if (poses.length === 0) return;

    const keypoints = poses[0].keypoints;

    keypoints.forEach(kp => {
        if (kp.score > 0.3) {
            poseCtx.beginPath();
            poseCtx.arc(kp.x, kp.y, 4, 0, 2 * Math.PI);
            poseCtx.fillStyle = '#00ffff';
            poseCtx.fill();
        }
    });

    const leftShoulder = keypoints.find(k => k.name === 'left_shoulder');
    const rightShoulder = keypoints.find(k => k.name === 'right_shoulder');
    if (leftShoulder && rightShoulder && leftShoulder.score > 0.3 && rightShoulder.score > 0.3) {
        poseCtx.beginPath();
        poseCtx.moveTo(leftShoulder.x, leftShoulder.y);
        poseCtx.lineTo(rightShoulder.x, rightShoulder.y);
        poseCtx.strokeStyle = '#ff00ff';
        poseCtx.lineWidth = 2;
        poseCtx.stroke();
    }
}

// ==========================================
// 6. モーション判定と座標マッピング
// ==========================================

function processPoseData(pose) {
    const keypoints = pose.keypoints;
    const nose = keypoints.find(k => k.name === 'nose');
    const leftShoulder = keypoints.find(k => k.name === 'left_shoulder');
    const rightShoulder = keypoints.find(k => k.name === 'right_shoulder');

    if (!nose || nose.score < 0.3) return;

    // --- 左右の座標（X軸）のマッピング ---
    const cameraWidth = poseCanvas.width;
    const targetX = (1.0 - (nose.x / cameraWidth) - 0.5) * (ROAD_WIDTH * 0.9);
    gameState.targetX = Math.max(-ROAD_WIDTH/2 - 1.0, Math.min(ROAD_WIDTH/2 + 1.0, targetX));

    // --- 前後の座標（Z軸）のマッピング ---
    if (leftShoulder && rightShoulder && leftShoulder.score > 0.3 && rightShoulder.score > 0.3) {
        const currentShoulderWidth = Math.hypot(
            leftShoulder.x - rightShoulder.x,
            leftShoulder.y - rightShoulder.y
        );

        if (gameState.shoulderWidthRef === null) {
            gameState.shoulderWidthRef = currentShoulderWidth;
        }

        const sensitivity = 0.05;
        const targetZ = -(currentShoulderWidth - gameState.shoulderWidthRef) * sensitivity;
        // 奥方向の範囲を -8.0m まで拡大
        gameState.targetZ = Math.max(-8.0, Math.min(3.0, targetZ));
    }
}

// ==========================================
// 7. ゲーム制御
// ==========================================

function startGame() {
    try {
        const nameInput = document.getElementById('player-name').value;
        gameState.playerName = nameInput.trim() || 'PLAYER-1';
        
        gameState.shoulderWidthRef = null; 

        document.getElementById('lobby-screen').classList.remove('active');
        document.getElementById('play-screen').classList.add('active');
        
        gameState.mode = 'playing';
        gameState.score = 0;
        
        gameState.cameraBaseZ = 0;
        gameState.playerZ = 0;
        gameState.playerX = 0;
        gameState.relativeX = 0;
        gameState.relativeZ = 0;
        gameState.targetX = 0;
        gameState.targetZ = 0;
        
        gameState.distance = ROAD_LENGTH;
        gameState.isFalling = false;
        gameState.fallY = 0;
        gameState.invincibleTimer = 0;
        gameState.legSwingTime = 0;
        
        resetObjects();

        document.getElementById('score-val').textContent = '0';
        document.getElementById('distance-val').textContent = ROAD_LENGTH + 'm';

        if (!gameState.looping) {
            gameState.looping = true;
            animate();
        }
    } catch (e) {
        console.error("startGame Error:", e);
        window.onerror(e.message, "game.js (startGame)", 0, 0, e);
    }
}

function resetObjects() {
    coins.forEach(c => scene.remove(c));
    obstacles.forEach(o => o.destroy());
    particles.forEach(p => scene.remove(p));
    
    coins = [];
    obstacles = [];
    particles = [];

    buildCourse();
}

function resetToLobby() {
    document.getElementById('result-screen').classList.remove('active');
    document.getElementById('lobby-screen').classList.add('active');
    gameState.mode = 'lobby';
    
    camera.position.set(0, 4.5, 5.0);
    camera.lookAt(new THREE.Vector3(0, 0.5, -10.0));
    renderer.render(scene, camera);
}

function finishGame() {
    gameState.mode = 'result';
    document.getElementById('play-screen').classList.remove('active');
    document.getElementById('result-screen').classList.add('active');

    document.getElementById('result-name').textContent = gameState.playerName;
    document.getElementById('result-score').textContent = gameState.score;

    sendScoreToGAS(gameState.playerName, gameState.score);
}

// ==========================================
// 8. メインゲームループ & アニメーション
// ==========================================

function animate() {
    if (gameState.mode !== 'playing') {
        gameState.looping = false;
        return;
    }

    requestAnimationFrame(animate);

    try {
        // --- 1. カメラの自動スクロール (前進) ---
        gameState.cameraBaseZ -= gameState.scrollSpeed;

        // --- 2. 姿勢座標のローパスフィルタ補正 ---
        if (!gameState.isFalling) {
            gameState.relativeX = (gameState.relativeX * 0.93) + (gameState.targetX * 0.07);
            gameState.relativeZ = (gameState.relativeZ * 0.93) + (gameState.targetZ * 0.07);
        }

        // --- 3. プレイヤー位置の計算 (直接マッピングに戻し、ワープを防ぐ) ---
        let playerY = 0;
        
        if (!gameState.isFalling) {
            gameState.playerX = gameState.relativeX;
            // 最初にいた位置からの相対量(relativeZ)をカメラZ基準に足すシンプルな計算 (ワープ防止)
            gameState.playerZ = gameState.cameraBaseZ + gameState.relativeZ;

            // --- 4. 道路セグメントに基づく足場（落下）判定 ---
            const currentZKey = Math.ceil(gameState.playerZ / 10) * 10;
            const segmentType = ROAD_SEGMENTS[currentZKey] || 'full';
            
            let isOffRoad = false;
            
            if (segmentType === 'full') {
                isOffRoad = Math.abs(gameState.playerX) > ROAD_WIDTH / 2;
            } else if (segmentType === 'narrow') {
                isOffRoad = Math.abs(gameState.playerX) > 1.5;
            } else if (segmentType === 'split') {
                isOffRoad = Math.abs(gameState.playerX) < 1.3 || Math.abs(gameState.playerX) > ROAD_WIDTH / 2;
            } else if (segmentType === 'gap') {
                isOffRoad = true;
            }

            if (isOffRoad) {
                gameState.isFalling = true;
                gameState.fallY = 0;
                // 落下時の復活待機時間を2秒間 (120フレーム) へ延長
                gameState.respawnTimer = 120;
                
                gameState.score = Math.max(0, gameState.score - 3);
                document.getElementById('score-val').textContent = gameState.score;
                
                showDamageText(gameState.playerX, 0, gameState.playerZ);
                triggerCameraShake(0.4);
                
                gameState.invincibleTimer = 120; // 無敵も2秒に
            }
        }

        // 落下中アニメーション
        if (gameState.isFalling) {
            gameState.fallY -= 0.15;
            playerY = gameState.fallY;
            gameState.respawnTimer--;
            
            if (gameState.respawnTimer <= 0) {
                // 復活処理
                gameState.isFalling = false;
                gameState.relativeX = 0;
                gameState.targetX = 0;
                gameState.relativeZ = 1.0;
                gameState.targetZ = 1.0;
                gameState.playerX = 0;
                gameState.playerZ = gameState.cameraBaseZ + 1.0;
                playerY = 0;
            }
        }

        // 無敵時間（点滅）の更新
        if (gameState.invincibleTimer > 0) {
            gameState.invincibleTimer--;
            const isVisible = Math.floor(gameState.invincibleTimer / 4) % 2 === 0;
            playerGroup.visible = isVisible;
        } else {
            playerGroup.visible = true;
        }

        playerGroup.position.set(gameState.playerX, playerY, gameState.playerZ);

        lights.playerSpot.position.set(gameState.playerX, playerY + 8, gameState.playerZ);
        lights.playerSpot.target = playerGroup;

        // --- 5. モーションシンクロの調整 (止まるモーションを廃止し常時走行) ---
        if (!gameState.isFalling) {
            // ゲーム中、常に走るモーションを再生
            gameState.legSwingTime += 0.15; 
            animatePlayerModel(gameState.legSwingTime);
        } else {
            playerGroup.leftLeg.rotation.x = Math.sin(Date.now() * 0.05) * 1.0;
            playerGroup.rightLeg.rotation.x = -Math.sin(Date.now() * 0.05) * 1.0;
            playerGroup.leftArm.rotation.x = -Math.sin(Date.now() * 0.05) * 1.0;
            playerGroup.rightArm.rotation.x = Math.sin(Date.now() * 0.05) * 1.0;
        }

        // --- 6. 敵キャラクターの更新 ---
        obstacles.forEach(obs => {
            obs.update(gameState.playerZ);
        });

        // --- 7. コインの更新と生えるアニメーション ---
        coins.forEach(coin => {
            coin.rotation.z += 0.05;

            if (coin.isHidden) {
                const distance = Math.abs(coin.position.z - gameState.playerZ);
                if (distance < 15.0) {
                    coin.position.y += (coin.targetY - coin.position.y) * 0.15;
                    const currentScale = coin.scale.x;
                    const nextScale = currentScale + (1.0 - currentScale) * 0.15;
                    coin.scale.set(nextScale, nextScale, nextScale);

                    if (coin.position.y >= coin.targetY - 0.05) {
                        coin.position.y = coin.targetY;
                        coin.scale.set(1, 1, 1);
                        coin.isHidden = false;
                    }
                }
            }
        });

        // --- 8. 背景の浮かぶ島をゆっくり移動させる ---
        floatingHills.forEach(hill => {
            if (hill.position.z > camera.position.z + 20) {
                hill.position.z -= 300;
            }
        });

        updateParticles();

        if (!gameState.isFalling) {
            checkCollisions(gameState.playerX, gameState.playerZ);
        }

        // --- 9. カメラのスクロール追従 ---
        camera.position.set(
            0,
            4.5,
            gameState.cameraBaseZ + 5.0
        );
        camera.lookAt(new THREE.Vector3(0, 0.5, gameState.cameraBaseZ - 10.0));

        // --- 10. UIの更新 ---
        const remainingDistance = Math.max(0, Math.round(ROAD_LENGTH + gameState.playerZ));
        gameState.distance = remainingDistance;
        document.getElementById('distance-val').textContent = remainingDistance + 'm';

        if (gameState.playerZ <= -ROAD_LENGTH) {
            finishGame();
        }

        renderer.render(scene, camera);
        
    } catch (e) {
        console.error("Animate Loop Error:", e);
        window.onerror(e.message, "game.js (animate)", 0, 0, e);
    }
}

function animatePlayerModel(time) {
    playerGroup.leftLeg.rotation.x = Math.sin(time) * 0.6;
    playerGroup.rightLeg.rotation.x = -Math.sin(time) * 0.6;
    playerGroup.leftArm.rotation.x = -Math.sin(time) * 0.5;
    playerGroup.rightArm.rotation.x = Math.sin(time) * 0.5;

    const deltaX = gameState.targetX - gameState.relativeX;
    playerGroup.rotation.y = deltaX * 0.5;
    playerGroup.rotation.z = -deltaX * 0.2;

    const deltaZ = gameState.targetZ - gameState.relativeZ;
    playerGroup.rotation.x = deltaZ * 0.3;
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.position.add(p.velocity);
        p.life--;
        p.material.opacity = p.life / 25;
        
        if (p.life <= 0) {
            scene.remove(p);
            particles.splice(i, 1);
        }
    }
}

// ==========================================
// 9. 衝突判定 (当たり判定)
// ==========================================

function checkCollisions(px, pz) {
    try {
        for (let i = coins.length - 1; i >= 0; i--) {
            const coin = coins[i];
            if (coin.isHidden) continue;

            const dist = Math.hypot(px - coin.position.x, pz - coin.position.z);
            if (dist < COLLISION_RADIUS) {
                gameState.score += 1;
                document.getElementById('score-val').textContent = gameState.score;
                
                spawnExplosion(coin.position);
                
                scene.remove(coin);
                coins.splice(i, 1);
            }
        }

        if (gameState.invincibleTimer === 0) {
            for (let i = obstacles.length - 1; i >= 0; i--) {
                const obs = obstacles[i];
                const box = obs.getCollisionBox();
                if (!box) continue;

                const dist = Math.hypot(px - box.x, pz - box.z);
                if (dist < box.radius && Math.abs(0.8 - box.y) < 1.5) {
                    gameState.score = Math.max(0, gameState.score - 3);
                    document.getElementById('score-val').textContent = gameState.score;

                    showDamageText(px, 0.8, pz);

                    obs.destroy();
                    obstacles.splice(i, 1);

                    triggerCameraShake(0.5);
                    
                    gameState.invincibleTimer = 120; // 衝突時の無敵時間も2秒に
                }
            }
        }
    } catch (e) {
        console.error("Collision Check Error:", e);
    }
}

let shakeIntensity = 0;
function triggerCameraShake(intensity = 0.3) {
    shakeIntensity = intensity;
    
    function shake() {
        if (shakeIntensity > 0.02 && gameState.mode === 'playing') {
            camera.position.x += (Math.random() - 0.5) * shakeIntensity;
            camera.position.y += (Math.random() - 0.5) * shakeIntensity;
            shakeIntensity *= 0.85;
            setTimeout(shake, 30);
        }
    }
    shake();
}

// ==========================================
// 10. データ連携 (GAS・スプレッドシート)
// ==========================================

async function sendScoreToGAS(playerName, score) {
    const GAS_URL = typeof GAS_WEB_APP_URL !== 'undefined' ? GAS_WEB_APP_URL : 'https://script.google.com/macros/s/AKfycbyCqTEtxX9mr1vxHP-8cOxXOCqYMp8887iPViTqXG8c7nqYbwDRDVBmMadPh4SeqQYH/exec'; 

    if (!GAS_URL) {
        console.log('GAS_URLが設定されていません。');
        showLocalRanking(playerName, score);
        return;
    }

    const rankingList = document.getElementById('ranking-list');
    if (rankingList) {
        rankingList.innerHTML = '<div class="ranking-item loading">スコアを送信中...</div>';
    }

    try {
        const response = await fetch(GAS_URL, {
            method: 'POST',
            mode: 'cors',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                playerName: playerName,
                score: score
            })
        });
        
        const result = await response.json();
        if (result.status === 'success') {
            if (rankingList) {
                rankingList.innerHTML = '<div class="ranking-item">送信成功しました！</div>';
            }
        } else {
            if (rankingList) {
                rankingList.innerHTML = '<div class="ranking-item">エラー: ' + result.message + '</div>';
            }
        }
    } catch (e) {
        console.error('GAS送信エラー:', e);
        if (rankingList) {
            rankingList.innerHTML = '<div class="ranking-item">オフラインモードで保存しました</div>';
        }
        showLocalRanking(playerName, score);
    }
}

function showLocalRanking(playerName, score) {
    let localScores = JSON.parse(localStorage.getItem('coin_road_scores') || '[]');
    localScores.push({ name: playerName, score: score, date: new Date().toLocaleString() });
    
    localScores.sort((a, b) => b.score - a.score);
    localScores = localScores.slice(0, 5);
    localStorage.setItem('coin_road_scores', JSON.stringify(localScores));

    const rankingList = document.getElementById('ranking-list');
    if (rankingList) {
        rankingList.innerHTML = '';
        localScores.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'ranking-item';
            if (index < 3) {
                div.className += ' top-three';
            }
            div.innerHTML = `
                <span>No.${index + 1} ${item.name}</span>
                <span>${item.score} 枚</span>
            `;
            rankingList.appendChild(div);
        });
    }
}
