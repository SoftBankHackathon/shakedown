fn value(input: &str) -> Result<i32, std::num::ParseIntError> { let n = input.parse::<i32>().unwrap(); Ok(n) }
