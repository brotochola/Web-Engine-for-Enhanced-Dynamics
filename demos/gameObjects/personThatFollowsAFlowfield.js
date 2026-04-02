import WEED from '/src/index.js';
import { DIRECTION_DOWN, PersonComponent } from '../components/personComponent.js';
import { PersonAnimationFSM } from '../fsm/PersonAnimationFSM.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { CarComponent } from '../components/carComponent.js';
import { ParticleEmitter, SpriteSheetRegistry, SoundManager } from '../../src/index.js';
import { CarPart } from './carPart.js';
import { Car } from './car.js';

const { rng, GameObject, RigidBody, Collider, CollisionListener, SpriteRenderer, NavGrid, Transform } = WEED;
// Reusable object for flowfield sampling (zero allocation)
const _navVec = { x: 0, y: 0 };
export class PersonThatFollowsAFlowfield extends GameObject {
    static scriptUrl = import.meta.url;
    static tickInterval = 4; // Tick every 10 frames (staggered across entities)

    static components = [RigidBody, Collider, CollisionListener, SpriteRenderer, PersonAnimationFSM, PersonComponent, LootableComponent];

    // Flocking behavior (override Person defaults)
    static groupingForce = 1;

    static defaultFriction = 0.005;

    static punchRangeSq = 30 ** 2; // Distance to start punching
    static punchDamage = 0.3; // Damage per punch
    static muzzleDistancePx = 30; // Distance from actor center to muzzle in world px
    static muzzleHeightPx = -30; // Visual muzzle height (negative = above ground)

    // Flocking behavior (static - same for all Person instances)
    static minSquaredDistanceToGroup = 140 ** 2;
    static groupingForce = 0;
    static separationForce = 0.66;
    static separationRadius = 30;
    static separationRadiusSq = this.separationRadius * this.separationRadius;
    // Damage resistance (static - same for all Person instances)
    static resistance = 0.5;
    static flowfieldName = 'sidewalks';
    onSpawned(spawnConfig = {}) {
        // Random spritesheet for variety
        const spritesheets = ['civil1', 'civil2', 'civil3'];
        const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
        this.setSpritesheet(randomSheet);
        this.setAnimation('idle_down');

        super.onSpawned(spawnConfig);

        // groupingForce now uses static class property (Civilian.groupingForce)

        // Physics properties
        this.rigidBody.maxVel = 3;
        this.rigidBody.minSpeed = 0;
        this.rigidBody.friction = PersonThatFollowsAFlowfield.defaultFriction;

        // Collision/perception
        this.collider.radius = 10;
        this.collider.visualRange = 350;

        // Sprite setup
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.98;
        this.spriteRenderer.animationSpeed = 0.15;
        // this.shadowCaster.heightMultiplier = 1.5

        // Random scale
        const scale = 0.7 + rng() * 0.2;
        this.setScale(scale, scale);

        this.collider.radius = 10 * scale;
        // Shadow uses default heightMultiplier = 1 (matches sprite scale)

        this.lootableComponent.health = 1;
        // resistance now uses static class property (Person.resistance)
        this.lootableComponent.dropMoney = 0//100;

        // Initialize facing direction (default: down)
        PersonComponent.facingDirection[this.index] = DIRECTION_DOWN;

        // Reset dead flag (entity indices are reused)
        PersonComponent.dead[this.index] = 0;

        // Reset shot cooldown (so recycled entities can fire immediately)
        PersonComponent.lastShotTime[this.index] = 0;

        // Aiming accuracy: 0 = max spread, 1 = perfect aim (default 0.8)
        PersonComponent.aimingAccuracy[this.index] = spawnConfig.aimingAccuracy ?? 0.8;

        // Reset team-throttle timestamp (entity indices are reused)
        PersonComponent.lastTeamDataUpdateTime[this.index] = 0;

        this.setScale(scale, scale);

        this.addShadowDecoration()
    }

    addShadowDecoration() {

        this.addDecoration('_whiteCircle_64x64', 0, 0, 0.33, 0.16, -1, {
            anchorX: 0.5,
            anchorY: 0.5,
            alpha: 0.25,
            offsetY: 0,
            tint: 0x000000,
        });

    }
    onCollisionEnter(other) {

        // Check if hit by a car (has carComponent)
        if (Transform.entityType[other] != CarPart.entityType) return;

        // Get car velocity
        const carVx = CarComponent.vx[other];
        const carVy = CarComponent.vy[other];

        // Get person velocity
        const myVx = RigidBody.vx[this.index];
        const myVy = RigidBody.vy[this.index];

        // Relative velocity (impact speed)
        const dvx = carVx - myVx;
        const dvy = carVy - myVy;
        const impactSpeed = Math.abs(dvx) + Math.abs(dvy)

        // Damage formula: impact speed converted to damage (tune as needed)
        const damageMultiplier = 0.1;
        const damage = impactSpeed * damageMultiplier;
        // if (damage < 0.2) return
        if (impactSpeed < 3) return

        // Apply damage
        const resistance = PersonThatFollowsAFlowfield.resistance;
        LootableComponent.health[this.index] -= damage

        // Emit blood particles
        ParticleEmitter.emit({
            count: Math.floor(damage * 20),
            texture: 'blood',
            x: this.x,
            y: this.y,
            z: -10,
            angleXY: { min: 0, max: 360 },
            speed: { min: 0.7, max: 2 },
            vz: { min: -4, max: 0 },
            lifespan: 2000,
            gravity: 0.15,
            scale: { min: 0.1, max: 0.2 },
            alpha: { min: 0.4, max: 0.9 },
            tint: { min: 0xaaaaaa, max: 0xffffff },
            stayOnTheFloor: true,
        });
    }

    die() {
        // Already dead? Don't trigger again
        if (PersonComponent.dead[this.index] === 1) return;

        // Mark as dead and increase friction
        this.rigidBody.friction = 0.9;
        PersonComponent.dead[this.index] = 1;

        // Play death sound
        const deathSounds = ['dolor1', 'dolor2', 'dolor3', 'dolor4'];
        const deathSound = deathSounds[(Math.random() * deathSounds.length) | 0];
        SoundManager.play(deathSound, 0.8, 0.9, 1.1, 0, 0, this.x, this.y);

        // Emit blood particles
        ParticleEmitter.emit({
            count: Math.floor(10 + Math.random() * 5),
            texture: 'blood',
            x: this.x,
            y: this.y,
            z: -10,
            angleXY: { min: 0, max: 360 },
            speed: { min: 0.7, max: 2 },
            vz: { min: -4, max: 0 },
            lifespan: 2000,
            gravity: 0.15,
            scale: { min: 0.1, max: 0.2 },
            alpha: { min: 0.4, max: 0.9 },
            tint: { min: 0xaaaaaa, max: 0xffffff },
            stayOnTheFloor: true,
        });

        // Start dying animation
        this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.DYING);
    }

    onDeathAnimationComplete() {
        // Stamp the corpse as a decal on the floor
        const spritesheetId = this.spriteRenderer.spritesheetId;
        const spritesheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);

        ParticleEmitter.stampDecal({
            spritesheet: spritesheetName,
            animation: 'hurt',
            frame: -1, // Last frame = death pose
            x: this.x,
            y: this.y - 8,
            scaleX: this.spriteRenderer.scaleX,
            scaleY: this.spriteRenderer.scaleY,
            tint: this.spriteRenderer.baseTint,
            alpha: 1,
        });

        // Remove the entity
        this.despawn();
    }

    avoidCars() {
        const myX = this.x;
        const myY = this.y;

        for (let n = 0; n < this.neighborCount; n++) {
            const neighborIndex = this.getNeighbor(n);

            // Only avoid cars
            if (Transform.entityType[neighborIndex] !== CarPart.entityType) continue;

            const carX = Transform.x[neighborIndex];
            const carY = Transform.y[neighborIndex];
            const speed = RigidBody.speed[neighborIndex]
            const dx = myX - carX;
            const dy = myY - carY;
            const dist = Math.hypot(dx, dy)

            const avoidStrength = 0.005 + speed * 0.002
            // Push away from car (normalized direction * strength)
            this.addAcceleration((dx / dist) * avoidStrength, (dy / dist) * avoidStrength);
        }
    }

    tick(dtRatio) {
        const isDead = PersonComponent.dead[this.index] === 1;

        // Check if health depleted -> trigger death
        if (!isDead && LootableComponent.health[this.index] <= 0) {
            this.die();
            return;
        }

        // Don't do normal behavior when dead
        if (isDead) {
            // Animation FSM handles dying animation
            if (this.spriteRenderer?.spritesheetId) {
                this.personAnimationFSM.tick(dtRatio, this);
            }
            return;
        }

        // Avoid nearby cars
        this.avoidCars();

        // Flowfield navigation
        NavGrid.requestVectorFromStaticFlowfield(PersonThatFollowsAFlowfield.flowfieldName, this.x, this.y, _navVec);
        const factor = 0.15;
        this.addAcceleration(_navVec.x * factor, _navVec.y * factor);

        // Separation: push away from neighbors that are too close
        const myX = this.x;
        const myY = this.y;
        const myEntityType = this.entityType;
        const separationRadiusSq = PersonThatFollowsAFlowfield.separationRadiusSq;
        const separationForce = PersonThatFollowsAFlowfield.separationForce;

        let separateX = 0;
        let separateY = 0;

        for (let n = 0; n < this.neighborCount; n++) {
            const neighborIndex = this.getNeighbor(n);

            // Only separate from same entity type
            if (Transform.entityType[neighborIndex] !== myEntityType) continue;

            const nx = Transform.x[neighborIndex];
            const ny = Transform.y[neighborIndex];
            const dx = myX - nx;
            const dy = myY - ny;
            const distSq = dx * dx + dy * dy;

            // If within separation radius (and not at exact same position)
            if (distSq < separationRadiusSq && distSq > 1) {
                const strength = (separationRadiusSq - distSq) / separationRadiusSq;
                separateX += (dx / distSq) * strength;
                separateY += (dy / distSq) * strength;
            }
        }

        // Apply separation force
        if (separateX !== 0 || separateY !== 0) {
            this.addAcceleration(separateX * separationForce, separateY * separationForce);
        }

        // Zero velocity when nearly stopped (helps FSM transition to IDLE)
        if (RigidBody.speed[this.index] < 0.166) {
            this.setVelocity(0, 0);
        }

        // Animation FSM handles all animation state
        if (this.spriteRenderer?.spritesheetId) {
            this.personAnimationFSM.tick(dtRatio, this);
        }
    }
}
