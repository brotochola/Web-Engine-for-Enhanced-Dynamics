https://claude.ai/chat/c87f1a63-c2e9-41ad-95d6-13f32334ce09
`

class CarComponent extends Component {
    static ARRAY_SCHEMA = {
        speed: Float32Array,
        direction: Float32Array,
        frontEntity: Uint16Array,
        backEntity: Uint16Array,
    };
}

class CarPart extends GameObject{
    static components = [RigidBody, Collider]

}

class Car extends GameObject {
    static components = [SpriteRenderer, CarComponent];

    tick(){
        //segun angulo entre frontEntity y backEntity cambiar de frame del spritesheet
    }

    gas(){

    }

    brake(){

    }

    onSpawned(){
        this.carComponent.frontEntity= CarPart.spawn()
        this.carComponent.backEntity= CarPart.spawn()
        //set position, radius, etc
        Constraint.add( this.carComponent.frontEntity,  this.carComponent.backEntity)

    }
    onDespawned(){
        CarPart.Despawn(this.carComponent.frontEntity)
        CarPart.Despawn(this.carComponent.backEntity)
    }
}

`