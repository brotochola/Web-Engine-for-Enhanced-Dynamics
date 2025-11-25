/**
 * Get parent classes in the inheritance chain
 * @param childClass - The class to get parents for
 * @returns Array of parent classes (excluding Object)
 */
export function getParentClasses<T extends Function>(childClass: T): Function[] {
  const parentClasses: Function[] = [];
  let currentClass: any = childClass;

  // Loop until the prototype chain reaches null (beyond Object.prototype)
  while (currentClass && currentClass !== Object) {
    const parent = Object.getPrototypeOf(currentClass);
    if (parent && parent !== Object.prototype.constructor) {
      // Exclude the base Object constructor
      parentClasses.push(parent);
      currentClass = parent;
    } else {
      break; // Reached the top of the inheritance chain
    }
  }
  return parentClasses;
}
